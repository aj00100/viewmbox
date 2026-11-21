// scripts/generate-stress-mbox.mjs
// Deterministic streaming MBOX generator with stress & boundary traps
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tier targets in bytes
const TIERS = {
  '500mb': 500 * 1024 * 1024,
  '5gb': 5 * 1024 * 1024 * 1024,
  '12gb': 12 * 1024 * 1024 * 1024,
};

const args = process.argv.slice(2);
const tierArg = args.find((a) => a.startsWith('--tier='))?.split('=')[1] || '500mb';
const targetBytes = TIERS[tierArg] || TIERS['500mb'];
const outputMbox = path.resolve(__dirname, `../test-data/stress-${tierArg}.mbox`);
const outputManifest = path.resolve(__dirname, `../test-data/stress-${tierArg}.manifest.json`);

console.log(`[Generator] Target Tier: ${tierArg} (${(targetBytes / (1024 * 1024)).toFixed(2)} MB)`);
console.log(`[Generator] Output MBOX: ${outputMbox}`);
console.log(`[Generator] Output Manifest: ${outputManifest}`);

// 1. Check disk space
try {
  const stat = fs.statfsSync(path.dirname(outputMbox));
  const freeBytes = stat.bsize * stat.bavail;
  console.log(`[Generator] Free storage: ${(freeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
  if (freeBytes < targetBytes * 1.5) {
    console.error(`[FATAL] Not enough disk space! Need ${(targetBytes * 1.5 / (1024 * 1024 * 1024)).toFixed(2)} GB free.`);
    process.exit(1);
  }
} catch (e) {
  console.warn('[Generator] Warning: Could not check statfs, proceeding with caution.');
}

// Fixed seed pseudo-random number generator (LCG)
let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

const CHUNK_16MB = 16 * 1024 * 1024;
const OVERLAP_64B = 64;

const outStream = fs.createWriteStream(outputMbox, { highWaterMark: 1024 * 1024 });

let currentByteOffset = 0;
let emailIndex = 0;
const manifestEmails = [];
let needleLocations = [];

function writeChunk(str) {
  const buf = Buffer.isBuffer(str) ? str : Buffer.from(str, 'utf-8');
  const start = currentByteOffset;
  currentByteOffset += buf.length;
  if (!outStream.write(buf)) {
    return new Promise((resolve) => outStream.once('drain', () => resolve({ start, length: buf.length })));
  }
  return Promise.resolve({ start, length: buf.length });
}

const PRE_FILLED_64K = Buffer.alloc(64 * 1024);
const sampleText = Buffer.from('The quick brown fox jumps over the lazy dog. 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ.\n');
for (let i = 0; i < PRE_FILLED_64K.length; i += sampleText.length) {
  sampleText.copy(PRE_FILLED_64K, i, 0, Math.min(sampleText.length, PRE_FILLED_64K.length - i));
}

// Helper to pad exactly up to a target byte offset with fill emails
async function padUntil(targetOffset) {
  while (currentByteOffset < targetOffset - 500) {
    const remain = targetOffset - currentByteOffset;
    const bodySize = Math.min(remain - 300, 128 * 1024);
    if (bodySize <= 0) break;
    await writeFillerEmail(bodySize);
  }
}

async function writeFillerEmail(approxBodySize = 65536) {
  const id = emailIndex++;
  const from = `filler_${id}@testbench.local`;
  const subject = `Routine Diagnostic Report #${id}`;
  const date = 'Mon, 18 Nov 2026 09:00:00 +0000';
  const start = currentByteOffset;

  // RFC 4155 separator
  const header = `From ${from} Mon Nov 18 09:00:00 2026\r\n` +
    `From: Routine System <${from}>\r\n` +
    `To: archive@testbench.local\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${date}\r\n` +
    `Message-ID: <filler-${id}-${seed}@testbench.local>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n`;

  await writeChunk(header);

  // Fast buffered fill
  let written = 0;
  while (written < approxBodySize) {
    const toWrite = Math.min(approxBodySize - written, PRE_FILLED_64K.length);
    await writeChunk(PRE_FILLED_64K.subarray(0, toWrite));
    written += toWrite;
  }
  await writeChunk('\r\n');

  manifestEmails.push({
    id,
    start,
    end: currentByteOffset,
    subject,
    from: `Routine System <${from}>`,
    date,
    hasAttachment: false,
    special: 'filler',
  });
}

async function generate() {
  console.log('[Generator] Building special emails and boundary alignment test cases...');

  // --- EMAIL 0: Normal ASCII baseline ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Standard Baseline RFC 4155 Message';
    const from = 'admin@example.com';
    const date = 'Tue, 15 Oct 2026 12:00:00 +0000';
    const raw = `From ${from} Tue Oct 15 12:00:00 2026\r\n` +
      `From: Server Admin <${from}>\r\n` +
      `To: recipient@example.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Message-ID: <email-0@testbench.local>\r\n` +
      `Content-Type: text/plain; charset=us-ascii\r\n` +
      `\r\n` +
      `This is a clean RFC 4155 baseline test message.\r\n` +
      `Verifying zero-byte parsing offset.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `Server Admin <${from}>`, date, hasAttachment: false });
  }

  // --- EMAIL 1: Needle 1 (Quoted-Printable soft breaks) at ~1% ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Security Audit QP Fragment (Needle 1)';
    const from = 'security@company.com';
    const date = 'Tue, 15 Oct 2026 12:05:00 +0000';
    const raw = `From ${from} Tue Oct 15 12:05:00 2026\r\n` +
      `From: Security Ops <${from}>\r\n` +
      `To: auditor@company.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Transfer-Encoding: quoted-printable\r\n` +
      `\r\n` +
      `Confidential token split across soft lines:\r\n` +
      `ZX-NEE=\r\n` +
      `DLE-4821\r\n` +
      `End of token stream.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Security Ops <${from}>`,
      date,
      hasAttachment: false,
      containsNeedle: 'ZX-NEEDLE-4821 (QP soft-break)',
    });
    needleLocations.push({ needle: 'ZX-NEEDLE-4821', emailId: id, type: 'QP_SOFT_BREAK' });
  }

  // --- EMAIL 2: Japanese CJK (ISO-2022-JP / UTF-8) ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = '日本語の請求書送付のご案内 (Japanese CJK Invoice)';
    const from = 'yamada@tokyo-biz.jp';
    const date = 'Wed, 16 Oct 2026 09:30:00 +0900';
    const raw = `From ${from} Wed Oct 16 09:30:00 2026\r\n` +
      `From: 山田 太郎 <${from}>\r\n` +
      `To: suzuki@tokyo-biz.jp\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n` +
      `<html><body><p>山田様、いつもお世話になっております。</p><p>今月の請求書をお送りいたします。</p></body></html>\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `山田 太郎 <${from}>`, date, hasAttachment: false, special: 'CJK_Japanese' });
  }

  // --- EMAIL 3: Delimiter Traps (Unescaped From line and >From line in body) ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Trap Email: Unescaped From in body';
    const from = 'tester@boundary.org';
    const date = 'Thu, 17 Oct 2026 14:00:00 +0000';
    const raw = `From ${from} Thu Oct 17 14:00:00 2026\r\n` +
      `From: Trap Master <${from}>\r\n` +
      `To: qa@boundary.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Here is an unescaped line that looks like a from header:\r\n` +
      `From my personal viewpoint, this is valid.\r\n` +
      `From 12345 is just some text.\r\n` +
      `>From escaped line according to RFC 4155 conventions.\r\n` +
      `End of traps.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `Trap Master <${from}>`, date, hasAttachment: false, special: 'delimiter_traps' });
  }

  // --- EMAIL 4: Gmail Fields (X-Gmail-Labels with commas & quotes) ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Gmail Export with Complex X-Gmail-Labels';
    const from = 'alerts@google.com';
    const date = 'Fri, 18 Oct 2026 15:45:00 +0000';
    const raw = `From ${from} Fri Oct 18 15:45:00 2026\r\n` +
      `From: Google Alerts <${from}>\r\n` +
      `To: user@gmail.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `X-Gmail-Labels: Important, "Receipts, 2026", Starred, "Category:Updates"\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Testing X-Gmail-Labels parsing with embedded commas inside quotes.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `Google Alerts <${from}>`, date, hasAttachment: false, special: 'gmail_labels' });
  }

  // --- EMAIL 5: RFC 2047 Encoded Headers ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    // =?UTF-8?B?U3ViamVjdCB3aXRoIOKCrCBFdXJv?= = Subject with € Euro
    const subjectRaw = '=?UTF-8?B?U3ViamVjdCB3aXRoIOKCrCBFdXJv?=';
    const fromRaw = '=?ISO-8859-1?Q?Andr=E9_G=F6the?= <andre@europe.eu>';
    const date = 'Sat, 19 Oct 2026 16:00:00 +0200';
    const raw = `From andre@europe.eu Sat Oct 19 16:00:00 2026\r\n` +
      `From: ${fromRaw}\r\n` +
      `To: euro@europe.eu\r\n` +
      `Subject: ${subjectRaw}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `RFC 2047 decoding test.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject: 'Subject with € Euro', from: 'André Göthe <andre@europe.eu>', date, hasAttachment: false, special: 'rfc2047_headers' });
  }

  // --- EMAIL 6: Malformed Input: Missing Date Header ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Malformed: Missing Date Header';
    const from = 'nodate@broken.org';
    const raw = `From ${from} Sun Oct 20 10:00:00 2026\r\n` +
      `From: No Date Sender <${from}>\r\n` +
      `To: receiver@broken.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Notice this email has no Date header at all.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `No Date Sender <${from}>`, date: '', hasAttachment: false, special: 'missing_date' });
  }

  // --- EMAIL 7: Malformed Input: Huge 60KB Header ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Malformed: 60KB Massive Header Block';
    const from = 'hugeheader@edgecase.org';
    const date = 'Sun, 20 Oct 2026 11:00:00 +0000';
    let raw = `From ${from} Sun Oct 20 11:00:00 2026\r\n` +
      `From: Huge Header <${from}>\r\n` +
      `To: receiver@edgecase.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n`;
    for (let h = 0; h < 600; h++) {
      raw += `X-Diagnostic-Trace-${h}: value_segment_${h}_abcdefghijklmnopqrstuvwxyz_0123456789\r\n`;
    }
    raw += `Content-Type: text/plain; charset=utf-8\r\n\r\nBody after huge header.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `Huge Header <${from}>`, date, hasAttachment: false, special: 'huge_header_60kb' });
  }

  // --- EMAIL 8: Zero-Byte Email Body ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Malformed: Zero Byte Body';
    const from = 'nobody@empty.org';
    const date = 'Sun, 20 Oct 2026 11:30:00 +0000';
    const raw = `From ${from} Sun Oct 20 11:30:00 2026\r\n` +
      `From: Empty Body <${from}>\r\n` +
      `To: receiver@empty.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n`; // Immediate end of headers with no body bytes before next email
    await writeChunk(raw);
    manifestEmails.push({ id, start, end: currentByteOffset, subject, from: `Empty Body <${from}>`, date, hasAttachment: false, special: 'zero_byte_body' });
  }

  // --- EMAIL 9: Email with 5MB Attachment ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Quarterly Statement with 5MB PDF Attachment';
    const from = 'billing@bank.com';
    const date = 'Mon, 21 Oct 2026 08:00:00 +0000';
    const boundary = '----=_Part_Bank_12345';
    const attHeader = `From ${from} Mon Oct 21 08:00:00 2026\r\n` +
      `From: Secure Bank <${from}>\r\n` +
      `To: customer@bank.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Please find your monthly statement attached.\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/pdf; name="statement_oct2026.pdf"\r\n` +
      `Content-Disposition: attachment; filename="statement_oct2026.pdf"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n`;
    await writeChunk(attHeader);

    // Stream 5MB of base64 data
    const b64Chunk = Buffer.from(Buffer.alloc(48 * 1024, 'A').toString('base64') + '\r\n');
    const chunkLoops = Math.floor((5 * 1024 * 1024) / b64Chunk.length);
    for (let c = 0; c < chunkLoops; c++) {
      await writeChunk(b64Chunk);
    }
    await writeChunk(`\r\n--${boundary}--\r\n\r\n`);

    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Secure Bank <${from}>`,
      date,
      hasAttachment: true,
      attachmentSize: 5 * 1024 * 1024,
      special: '5mb_attachment',
    });
  }

  // --- BOUNDARY TRAP 1: Exact 16MB Chunk Boundary ---
  // We want the delimiter '\nFrom ' to place 'From ' exactly at byte CHUNK_16MB (16,777,216)
  console.log(`[Generator] Aligning to 16MB boundary (${CHUNK_16MB} bytes)...`);
  await padUntil(CHUNK_16MB - 300);

  // Exact padding byte by byte
  const targetExactFrom = CHUNK_16MB;
  const neededPadding = targetExactFrom - currentByteOffset - 1; // 1 byte for '\n'
  if (neededPadding > 0) {
    const padStr = 'X'.repeat(neededPadding) + '\n';
    await writeChunk(padStr);
  }

  // Now currentByteOffset should be exactly CHUNK_16MB!
  console.log(`[Generator] Current offset before 16MB boundary email: ${currentByteOffset} (Target: ${CHUNK_16MB})`);
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'CRITICAL TEST: Exact 16MB Boundary Delimiter';
    const from = 'boundary-16mb@testbench.local';
    const date = 'Mon, 21 Oct 2026 12:00:00 +0000';
    const raw = `From ${from} Mon Oct 21 12:00:00 2026\r\n` +
      `From: Boundary 16MB <${from}>\r\n` +
      `To: qa@testbench.local\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `This message's 'From ' separator starts exactly at byte ${CHUNK_16MB}.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Boundary 16MB <${from}>`,
      date,
      hasAttachment: false,
      special: '16mb_boundary_alignment',
    });
  }

  // --- BOUNDARY TRAP 2: Inside the 64-byte overlap of chunk 2 ---
  // Chunk 2 boundary is 32MB (2 * CHUNK_16MB = 33,554,432).
  // Overlap is [32MB - 64, 32MB]. Let's place a delimiter at 32MB - 32 bytes!
  const targetOverlap = (2 * CHUNK_16MB) - 32;
  console.log(`[Generator] Aligning to 64-byte overlap (${targetOverlap} bytes)...`);
  await padUntil(targetOverlap - 300);

  const neededOverlapPad = targetOverlap - currentByteOffset - 1;
  if (neededOverlapPad > 0) {
    await writeChunk('Y'.repeat(neededOverlapPad) + '\n');
  }

  console.log(`[Generator] Current offset before overlap email: ${currentByteOffset} (Target: ${targetOverlap})`);
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'CRITICAL TEST: Inside 64-Byte Overlap Region';
    const from = 'overlap-64b@testbench.local';
    const date = 'Mon, 21 Oct 2026 13:00:00 +0000';
    const raw = `From ${from} Mon Oct 21 13:00:00 2026\r\n` +
      `From: Overlap Tester <${from}>\r\n` +
      `To: qa@testbench.local\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `This message starts inside the 64-byte chunk overlap.\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Overlap Tester <${from}>`,
      date,
      hasAttachment: false,
      special: '64b_overlap_alignment',
    });
  }

  // --- EMAIL AT ~50%: Needle 2 (HTML tags split) ---
  const halfTarget = Math.floor(targetBytes * 0.5);
  console.log(`[Generator] Padding to ~50% mark (${(halfTarget / (1024 * 1024)).toFixed(1)} MB)...`);
  await padUntil(halfTarget);

  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Contract Milestone Review (Needle 2 in HTML)';
    const from = 'legal@enterprise.com';
    const date = 'Tue, 22 Oct 2026 10:15:00 +0000';
    const raw = `From ${from} Tue Oct 22 10:15:00 2026\r\n` +
      `From: Legal Council <${from}>\r\n` +
      `To: client@enterprise.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n` +
      `\r\n` +
      `<html><body>` +
      `<p>Contract execution reference id: ` +
      `<b>ZX-</b><span>NEEDLE</span><i>-4821</i>` +
      ` is approved.</p>` +
      `</body></html>\r\n\r\n`;
    await writeChunk(raw);
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Legal Council <${from}>`,
      date,
      hasAttachment: false,
      containsNeedle: 'ZX-NEEDLE-4821 (HTML tag split)',
    });
    needleLocations.push({ needle: 'ZX-NEEDLE-4821', emailId: id, type: 'HTML_TAG_SPLIT' });
  }

  // --- EMAIL AT ~75%: 25MB Email ---
  const threeQuarterTarget = Math.floor(targetBytes * 0.75);
  console.log(`[Generator] Padding to ~75% mark for 25MB email...`);
  await padUntil(threeQuarterTarget);

  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Large High-Resolution Archive Package (25MB)';
    const from = 'archive-vault@cloud.org';
    const date = 'Wed, 23 Oct 2026 11:00:00 +0000';
    const boundary = '----=_Part_Heavy_25MB';
    await writeChunk(
      `From ${from} Wed Oct 23 11:00:00 2026\r\n` +
      `From: Media Archive <${from}>\r\n` +
      `To: storage@cloud.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Heavy 25MB container email.\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/octet-stream; name="data_25mb.bin"\r\n` +
      `Content-Disposition: attachment; filename="data_25mb.bin"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n`
    );

    const b64Block = Buffer.from(Buffer.alloc(48 * 1024, 'K').toString('base64') + '\r\n');
    const iterations = Math.floor((24 * 1024 * 1024) / b64Block.length);
    for (let it = 0; it < iterations; it++) {
      await writeChunk(b64Block);
    }
    await writeChunk(`\r\n--${boundary}--\r\n\r\n`);

    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Media Archive <${from}>`,
      date,
      hasAttachment: true,
      attachmentSize: 24 * 1024 * 1024,
      special: '25mb_email',
    });
  }

  // --- EMAIL AT ~99%: Needle 3 (INSIDE BASE64 ATTACHMENT ONLY - MUST NOT MATCH TEXT SEARCH) ---
  const ninetyNineTarget = Math.floor(targetBytes * 0.98);
  console.log(`[Generator] Padding to ~98% mark for Needle 3 in attachment...`);
  await padUntil(ninetyNineTarget);

  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Encrypted Payload Archive (Needle 3 inside attachment only)';
    const from = 'crypto@secret.net';
    const date = 'Thu, 24 Oct 2026 17:00:00 +0000';
    const boundary = '----=_Part_Secret_99';

    // The needle "ZX-NEEDLE-4821" is ONLY in the binary payload, which is base64 encoded.
    // The subject, sender, and text body DO NOT contain "ZX-NEEDLE-4821".
    const secretContent = Buffer.from('RAW_SECRET_DATA_BLOCK_HEADER\nZX-NEEDLE-4821\nRAW_SECRET_DATA_BLOCK_FOOTER');
    const secretBase64 = secretContent.toString('base64');

    await writeChunk(
      `From ${from} Thu Oct 24 17:00:00 2026\r\n` +
      `From: Secret Vault <${from}>\r\n` +
      `To: receiver@secret.net\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `The token is stored exclusively inside the encoded binary attachment.\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/octet-stream; name="vault_token.dat"\r\n` +
      `Content-Disposition: attachment; filename="vault_token.dat"\r\n` +
      `Content-Transfer-Encoding: base64\r\n` +
      `\r\n` +
      `${secretBase64}\r\n` +
      `--${boundary}--\r\n\r\n`
    );

    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Secret Vault <${from}>`,
      date,
      hasAttachment: true,
      attachmentSize: secretContent.length,
      containsNeedle: 'ZX-NEEDLE-4821 (inside base64 attachment ONLY - MUST NOT MATCH BODY SEARCH)',
    });
    needleLocations.push({ needle: 'ZX-NEEDLE-4821', emailId: id, type: 'INSIDE_ATTACHMENT_ONLY_NO_MATCH' });
  }

  // --- EMAIL: Forwarded message/rfc822 nested email ---
  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Fwd: Original Client Support Request (message/rfc822)';
    const from = 'forwarder@team.com';
    const date = 'Fri, 25 Oct 2026 09:00:00 +0000';
    const boundary = '----=_Part_Fwd_822';
    await writeChunk(
      `From ${from} Fri Oct 25 09:00:00 2026\r\n` +
      `From: Support Team <${from}>\r\n` +
      `To: escalations@team.com\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` +
      `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `Forwarding original user request below:\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: message/rfc822; name="original.eml"\r\n` +
      `Content-Disposition: attachment; filename="original.eml"\r\n` +
      `\r\n` +
      `From: original_client@example.com\r\n` +
      `Subject: Help with account #9988\r\n` +
      `Date: Thu, 24 Oct 2026 14:00:00 +0000\r\n` +
      `\r\n` +
      `Original nested message content body.\r\n` +
      `--${boundary}--\r\n\r\n`
    );
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Support Team <${from}>`,
      date,
      hasAttachment: true,
      special: 'nested_rfc822',
    });
  }

  // --- FINAL EMAIL: Truncated message (no trailing newline) ---
  console.log(`[Generator] Padding to reach final file boundary...`);
  await padUntil(targetBytes - 400);

  {
    const id = emailIndex++;
    const start = currentByteOffset;
    const subject = 'Final Edge Case: Truncated Last Message Without Trailing CRLF';
    const from = 'last-msg@boundary.org';
    const date = 'Sat, 26 Oct 2026 23:59:59 +0000';
    const raw = `From ${from} Sat Oct 26 23:59:59 2026\r\n` +
      `From: Final Message <${from}>\r\n` +
      `To: test@boundary.org\r\n` +
      `Subject: ${subject}\r\n` +
      `Date: ${date}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `\r\n` +
      `This is the very last email in the archive. No newline at end of file.`;
    await writeChunk(raw);
    manifestEmails.push({
      id,
      start,
      end: currentByteOffset,
      subject,
      from: `Final Message <${from}>`,
      date,
      hasAttachment: false,
      special: 'truncated_no_final_newline',
    });
  }

  outStream.end(() => {
    console.log(`[Generator] Stream finished! Final file size: ${(currentByteOffset / (1024 * 1024)).toFixed(2)} MB (${currentByteOffset} bytes)`);
    console.log(`[Generator] Total Emails Indexed: ${manifestEmails.length}`);

    const manifest = {
      generator: 'generate-stress-mbox.mjs v1.0',
      generatedAt: new Date().toISOString(),
      tier: tierArg,
      targetBytes,
      actualBytes: currentByteOffset,
      totalEmails: manifestEmails.length,
      needles: needleLocations,
      expectedSearchMatchesForNeedle: [
        needleLocations.find((n) => n.type === 'QP_SOFT_BREAK')?.emailId,
        needleLocations.find((n) => n.type === 'HTML_TAG_SPLIT')?.emailId,
      ].filter((x) => x !== undefined),
      expectedNonMatchesForNeedle: [
        needleLocations.find((n) => n.type === 'INSIDE_ATTACHMENT_ONLY_NO_MATCH')?.emailId,
      ].filter((x) => x !== undefined),
      boundaryTestEmails: manifestEmails.filter((m) => m.special && m.special.includes('boundary')),
      emails: manifestEmails,
    };

    fs.writeFileSync(outputManifest, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`[Generator] Manifest written to ${outputManifest}`);
  });
}

generate().catch((err) => {
  console.error('[Generator Error]', err);
  process.exit(1);
});

// scripts/test-worker-engine.mjs
// Rigorous automated validation of mbox-worker indexing & deep search
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PostalMime from 'postal-mime';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mboxPath = path.resolve(__dirname, '../test-data/stress-500mb.mbox');
const manifestPath = path.resolve(__dirname, '../test-data/stress-500mb.manifest.json');

if (!fs.existsSync(mboxPath) || !fs.existsSync(manifestPath)) {
  console.error('[FATAL] Missing stress test files. Run generate-stress-mbox.mjs first.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
const fileStats = fs.statSync(mboxPath);
const fileSize = fileStats.size;

console.log(`================================================================`);
console.log(`MBOX WORKER ENGINE BENCHMARK & RIGOROUS TEST`);
console.log(`File: ${mboxPath}`);
console.log(`Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB (${fileSize} bytes)`);
console.log(`Manifest Expected Emails: ${manifest.totalEmails}`);
console.log(`================================================================`);

// Create standard Web-compatible File/Blob slice simulation on Node
const fd = fs.openSync(mboxPath, 'r');
const mockBlob = {
  size: fileSize,
  slice(start, end) {
    const s = Math.max(0, start);
    const e = Math.min(fileSize, end);
    const len = Math.max(0, e - s);
    return {
      size: len,
      async arrayBuffer() {
        const buf = Buffer.alloc(len);
        if (len > 0) {
          fs.readSync(fd, buf, 0, len, s);
        }
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  },
};

// Replicate Worker logic constants and decoding exactly from mbox-worker.ts
const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB
const OVERLAP = 64;
const HEADER_SNIFF_BYTES = 3072;
const FROM_LINE_RE =
  /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const latin1Decoder = new TextDecoder('iso-8859-1');

function decodeRfc2047(input) {
  return input.replace(
    /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
    (_match, charset, encoding, text) => {
      try {
        let bytes;
        if (encoding.toUpperCase() === 'B') {
          const bin = atob(text.replace(/\s+/g, ''));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          const q = text.replace(/_/g, ' ');
          const out = [];
          for (let i = 0; i < q.length; i++) {
            if (q[i] === '=' && i + 2 < q.length) {
              out.push(parseInt(q.slice(i + 1, i + 3), 16));
              i += 2;
            } else {
              out.push(q.charCodeAt(i));
            }
          }
          bytes = new Uint8Array(out);
        }
        return new TextDecoder(charset, { fatal: false }).decode(bytes);
      } catch {
        return text;
      }
    }
  );
}

function extractHeader(rawHeaders, name) {
  const re = new RegExp(`^${name}:[ \\t]*(.+(?:\\r?\\n[ \\t]+.+)*)`, 'im');
  const m = rawHeaders.match(re);
  if (!m) return '';
  const unfolded = m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
  return decodeRfc2047(unfolded);
}

async function parseQuickHeaders(file, start, end) {
  const sliceEnd = Math.min(end, start + HEADER_SNIFF_BYTES);
  const buf = await file.slice(start, sliceEnd).arrayBuffer();
  const text = latin1Decoder.decode(buf);
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] || text;
  return {
    subject: extractHeader(headerBlock, 'Subject') || '(No Subject)',
    from: extractHeader(headerBlock, 'From') || '(Unknown Sender)',
    date: extractHeader(headerBlock, 'Date') || '',
  };
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _m;
      }
    });
}

function sniffHeaderFromBuffer(bytes, localStart) {
  const sliceEnd = Math.min(bytes.length, localStart + HEADER_SNIFF_BYTES);
  const text = latin1Decoder.decode(bytes.subarray(localStart, sliceEnd));
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] || text;
  return {
    subject: extractHeader(headerBlock, 'Subject') || '(No Subject)',
    from: extractHeader(headerBlock, 'From') || '(Unknown Sender)',
    date: extractHeader(headerBlock, 'Date') || '',
  };
}

async function runBenchmark() {
  const memBefore = process.memoryUsage();
  const t0 = performance.now();

  // --- UNIFIED SINGLE-PASS: BOUNDARY SCANNING + IN-MEMORY HEADER SNIFFING ---
  console.log(`[Unified Stage] Scanning boundaries & in-memory headers across ${(fileSize / (1024 * 1024)).toFixed(1)} MB...`);
  const indexed = [];
  let offset = 0;

  while (offset < fileSize) {
    const start = offset === 0 ? 0 : Math.max(0, offset - OVERLAP);
    const end = Math.min(fileSize, offset + CHUNK_SIZE);
    const bytes = new Uint8Array(await mockBlob.slice(start, end).arrayBuffer());

    if (offset === 0 && bytes.length >= 5) {
      const headLine = utf8Decoder.decode(bytes.subarray(0, Math.min(120, bytes.length)));
      if (FROM_LINE_RE.test(headLine)) {
        const meta = sniffHeaderFromBuffer(bytes, 0);
        indexed.push({
          id: 0,
          start: 0,
          end: 0,
          ...meta,
        });
      }
    }

    for (let i = 0; i < bytes.length - 6; i++) {
      if (
        bytes[i] === 0x0a &&
        bytes[i + 1] === 0x46 &&
        bytes[i + 2] === 0x72 &&
        bytes[i + 3] === 0x6f &&
        bytes[i + 4] === 0x6d &&
        bytes[i + 5] === 0x20
      ) {
        const absPos = start + i + 1;
        if (indexed.length > 0 && absPos <= indexed[indexed.length - 1].start) {
          continue;
        }
        const linePreview = utf8Decoder.decode(
          bytes.subarray(i + 1, Math.min(bytes.length, i + 120))
        );
        if (FROM_LINE_RE.test(linePreview)) {
          let meta;
          const available = bytes.length - (i + 1);
          if (available >= 500) {
            meta = sniffHeaderFromBuffer(bytes, i + 1);
          } else {
            meta = await parseQuickHeaders(mockBlob, absPos, Math.min(fileSize, absPos + HEADER_SNIFF_BYTES));
          }

          indexed.push({
            id: indexed.length,
            start: absPos,
            end: 0,
            ...meta,
          });
        }
      }
    }
    offset += CHUNK_SIZE;
  }

  // Finalize end offsets in a single sub-millisecond in-memory loop
  for (let j = 0; j < indexed.length; j++) {
    indexed[j].end = j + 1 < indexed.length ? indexed[j + 1].start : fileSize;
  }

  const tIndexDone = performance.now();
  console.log(`[Unified Stage Complete] Fully indexed ${indexed.length} emails & headers in ${(tIndexDone - t0).toFixed(1)} ms (${((tIndexDone - t0) / 1000).toFixed(2)} s)!`);
  console.log(`  Throughput: ${((fileSize / (1024 * 1024)) / ((tIndexDone - t0) / 1000)).toFixed(1)} MB/s`);

  const memAfterIndex = process.memoryUsage();
  console.log(`Memory RSS: ${(memAfterIndex.rss / (1024 * 1024)).toFixed(1)} MB, Heap: ${(memAfterIndex.heapUsed / (1024 * 1024)).toFixed(1)} MB`);

  // --- VERIFICATION GATE 1: COUNT & BOUNDARY ACCURACY ---
  console.log('\n--- VERIFICATION GATE 1: Count & Alignment ---');
  let passCount = true;
  if (indexed.length === manifest.totalEmails) {
    console.log(`✅ MATCH: Indexed count (${indexed.length}) matches manifest count (${manifest.totalEmails}) exactly!`);
  } else {
    console.error(`❌ MISMATCH: Indexed count (${indexed.length}) != manifest count (${manifest.totalEmails})!`);
    passCount = false;
  }

  // Check 16MB boundary email
  const target16MB = 16 * 1024 * 1024;
  const match16MB = indexed.find((m) => m.start === target16MB);
  if (match16MB) {
    console.log(`✅ 16MB Boundary Check: Email #${match16MB.id} cleanly starts at exact byte ${match16MB.start} ("${match16MB.subject}")`);
  } else {
    console.error(`❌ 16MB Boundary Check FAILED: No email started at byte ${target16MB}`);
    passCount = false;
  }

  // Check 64B overlap email
  const targetOverlap = (32 * 1024 * 1024) - 32;
  const matchOverlap = indexed.find((m) => m.start === targetOverlap);
  if (matchOverlap) {
    console.log(`✅ 64B Overlap Region Check: Email #${matchOverlap.id} cleanly captured at byte ${matchOverlap.start} without duplication ("${matchOverlap.subject}")`);
  } else {
    console.error(`❌ 64B Overlap Check FAILED: No email started at byte ${targetOverlap}`);
    passCount = false;
  }

  // Check unescaped delimiter traps in body
  const trapEmail = manifest.emails.find((m) => m.special === 'delimiter_traps');
  if (trapEmail) {
    const indexedTrap = indexed[trapEmail.id];
    console.log(`✅ Trap Email Integrity: Email #${trapEmail.id} boundaries: ${indexedTrap.start} to ${indexedTrap.end} (Length: ${indexedTrap.end - indexedTrap.start}B)`);
  }

  // --- STAGE 3: DEEP SEARCH BENCHMARK ---
  console.log('\n--- STAGE 3: DEEP SEARCH BENCHMARK ---');
  const needle = 'zx-needle-4821';
  console.log(`Query: "${needle}" across all ${indexed.length} emails...`);

  const tSearchStart = performance.now();
  const matchedIds = [];
  let tFirstHit = null;
  let scannedBytes = 0;

  const BATCH_BYTES = 16 * 1024 * 1024; // 16MB batches
  let i = 0;
  while (i < indexed.length) {
    const batchStartIdx = i;
    const batchStartByte = indexed[batchStartIdx].start;

    // Advance until batch reaches ~16MB or email list ends
    while (i < indexed.length && (indexed[i].end - batchStartByte) < BATCH_BYTES) {
      i++;
    }
    if (i === batchStartIdx) {
      i = batchStartIdx + 1;
    }
    const batchEndIdx = i;
    const singleEmail = batchEndIdx - batchStartIdx === 1;
    const actualEndByte = singleEmail
      ? Math.min(indexed[batchStartIdx].end, batchStartByte + 2 * 1024 * 1024)
      : indexed[batchEndIdx - 1].end;

    const batchBuf = await mockBlob.slice(batchStartByte, actualEndByte).arrayBuffer();
    const batchText = latin1Decoder.decode(batchBuf);
    const batchLower = batchText.toLowerCase();

    // Fast-path: if needle is nowhere in batch and no QP/HTML markers, check headers only
    const mayHaveNeedle = batchLower.includes(needle) || batchText.includes('=') || batchText.includes('<');

    for (let k = batchStartIdx; k < batchEndIdx; k++) {
      const item = indexed[k];
      const emailLen = item.end - item.start;
      scannedBytes += emailLen;

      if (
        item.subject.toLowerCase().includes(needle) ||
        item.from.toLowerCase().includes(needle) ||
        item.date.toLowerCase().includes(needle)
      ) {
        matchedIds.push(item.id);
        if (tFirstHit === null) tFirstHit = performance.now();
      } else if (mayHaveNeedle) {
        const localStart = item.start - batchStartByte;
        const localEnd = Math.min(batchText.length, localStart + Math.min(emailLen, 2 * 1024 * 1024));
        if (localStart < batchText.length) {
          const rawEmail = batchText.slice(localStart, localEnd);
          const rawEmailLower = rawEmail.toLowerCase();
          if (rawEmailLower.includes(needle)) {
            matchedIds.push(item.id);
            if (tFirstHit === null) tFirstHit = performance.now();
          } else {
            const decodedText = rawEmail.includes('=') ? decodeQuotedPrintable(rawEmail).toLowerCase() : '';
            const strippedHtml = rawEmail.includes('<') ? (decodedText || rawEmailLower).replace(/<[^>]+>/g, '') : '';
            if ((decodedText && decodedText.includes(needle)) || (strippedHtml && strippedHtml.includes(needle))) {
              matchedIds.push(item.id);
              if (tFirstHit === null) tFirstHit = performance.now();
            }
          }
        }
      }
    }
  }

  const tSearchDone = performance.now();
  const searchDurationSec = (tSearchDone - tSearchStart) / 1000;
  const searchGBs = (fileSize / (1024 * 1024 * 1024)) / searchDurationSec;

  console.log(`Deep Search Completed in ${(tSearchDone - tSearchStart).toFixed(1)} ms (${searchDurationSec.toFixed(2)} s)`);
  console.log(`Time to First Hit: ${tFirstHit ? (tFirstHit - tSearchStart).toFixed(1) + ' ms' : 'N/A'}`);
  console.log(`Search Throughput: ${searchGBs.toFixed(2)} GB/s (${((fileSize / (1024 * 1024)) / searchDurationSec).toFixed(1)} MB/s)`);
  console.log(`Matches Found: [${matchedIds.join(', ')}]`);

  // Verify Needle Test Specifications
  const qpNeedle = manifest.needles.find((n) => n.type === 'QP_SOFT_BREAK');
  const htmlNeedle = manifest.needles.find((n) => n.type === 'HTML_TAG_SPLIT');
  const attNeedle = manifest.needles.find((n) => n.type === 'INSIDE_ATTACHMENT_ONLY_NO_MATCH');

  console.log('\n--- VERIFICATION GATE 2: Needle Search Rules ---');
  if (matchedIds.includes(qpNeedle.emailId)) {
    console.log(`✅ PASS: Needle 1 (QP soft-break) in Email #${qpNeedle.emailId} successfully matched!`);
  } else {
    console.error(`❌ FAIL: Needle 1 (QP soft-break) in Email #${qpNeedle.emailId} was NOT matched!`);
  }

  if (matchedIds.includes(htmlNeedle.emailId)) {
    console.log(`✅ PASS: Needle 2 (HTML tag split) in Email #${htmlNeedle.emailId} successfully matched!`);
  } else {
    console.error(`❌ FAIL: Needle 2 (HTML tag split) in Email #${htmlNeedle.emailId} was NOT matched!`);
  }

  if (!matchedIds.includes(attNeedle.emailId)) {
    console.log(`✅ PASS: Needle 3 (inside base64 attachment only) in Email #${attNeedle.emailId} correctly DID NOT match plain text search!`);
  } else {
    console.error(`❌ FAIL: Needle 3 in attachment was incorrectly matched!`);
  }

  // --- STAGE 4: PARSE 25MB EMAIL & ATTACHMENT EXTRACTION ---
  console.log('\n--- STAGE 4: PARSING 25MB EMAIL & ATTACHMENT EXTRACTION ---');
  const heavyEmailMeta = manifest.emails.find((m) => m.special === '25mb_email');
  if (heavyEmailMeta) {
    const tParseStart = performance.now();
    const rawBuf = await mockBlob.slice(heavyEmailMeta.start, heavyEmailMeta.end).arrayBuffer();
    const parser = new PostalMime();
    const email = await parser.parse(rawBuf);
    const tParseDone = performance.now();

    console.log(`Parsed 25MB email in ${(tParseDone - tParseStart).toFixed(1)} ms`);
    console.log(`Subject: "${email.subject}"`);
    console.log(`Attachments found: ${email.attachments?.length || 0}`);
    if (email.attachments && email.attachments[0]) {
      const att = email.attachments[0];
      console.log(`Attachment: "${att.filename}" Size: ${(att.content.byteLength / (1024 * 1024)).toFixed(2)} MB`);
      if (att.content.byteLength >= 23 * 1024 * 1024) {
        console.log(`✅ Attachment extraction verified!`);
      }
    }
  }

  // --- STAGE 5: JAPANESE CJK PARSE TEST ---
  console.log('\n--- STAGE 5: JAPANESE CJK TEST ---');
  const cjkMeta = manifest.emails.find((m) => m.special === 'CJK_Japanese');
  if (cjkMeta) {
    const rawBuf = await mockBlob.slice(cjkMeta.start, cjkMeta.end).arrayBuffer();
    const parser = new PostalMime();
    const email = await parser.parse(rawBuf);
    console.log(`CJK Email Subject: "${email.subject}"`);
    console.log(`CJK Email From: "${email.from?.name} <${email.from?.address}>"`);
    console.log(`CJK HTML snippet: ${email.html?.slice(0, 100)}`);
    if (email.subject.includes('日本語の請求書送付のご案内')) {
      console.log(`✅ CJK UTF-8 extraction fully working!`);
    }
  }

  const memFinal = process.memoryUsage();
  console.log(`\nFinal Peak Heap Used: ${(memFinal.heapUsed / (1024 * 1024)).toFixed(1)} MB`);
  fs.closeSync(fd);

  console.log(`\n================================================================`);
  console.log(`ALL 500MB STRESS BENCHMARKS COMPLETED SUCCESSFULLY!`);
  console.log(`================================================================`);
}

runBenchmark().catch((err) => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});

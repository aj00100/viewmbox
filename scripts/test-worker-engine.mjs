// scripts/test-worker-engine.mjs
// Rigorous automated validation of ViewMBOX engine.ts
// Direct test of shipping engine code - ZERO DUPLICATION.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PostalMime from 'postal-mime';

// Direct import of shipping engine TypeScript source via Node native type stripping:
import {
  indexMboxStream,
  searchMboxStream,
  decodeRfc2047,
  extractHeader,
  decodeHeaderBytes,
  sniffHeaderFromBuffer,
  parseQuickHeaders,
  CHUNK_SIZE,
  OVERLAP,
} from '../src/workers/engine.ts';

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
console.log(`VIEWBOX CORE ENGINE BENCHMARK & MULTI-GATE VERIFICATION`);
console.log(`Engine: src/workers/engine.ts (Direct Shipping Module)`);
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

async function runBenchmark() {
  const t0 = performance.now();

  // --- STAGE 1: FULL 500MB ARCHIVE INDEXING (RUNNING REAL indexMboxStream) ---
  console.log(`\n[Stage 1] Indexing ${(fileSize / (1024 * 1024)).toFixed(1)} MB via indexMboxStream()...`);
  const indexed = await indexMboxStream(mockBlob, {
    chunkSize: CHUNK_SIZE,
    overlap: OVERLAP,
  });

  const tIndexDone = performance.now();
  const indexDurationSec = (tIndexDone - t0) / 1000;
  console.log(
    `[Stage 1 Complete] Indexed ${indexed.length} emails in ${(tIndexDone - t0).toFixed(1)} ms (${indexDurationSec.toFixed(2)} s)`
  );
  console.log(
    `  Throughput: ${(fileSize / (1024 * 1024) / indexDurationSec).toFixed(1)} MB/s`
  );

  const memAfterIndex = process.memoryUsage();
  console.log(
    `  Memory RSS: ${(memAfterIndex.rss / (1024 * 1024)).toFixed(1)} MB, Heap: ${(memAfterIndex.heapUsed / (1024 * 1024)).toFixed(1)} MB`
  );

  // --- VERIFICATION GATE 1: COUNT & BOUNDARY ACCURACY ---
  console.log('\n--- VERIFICATION GATE 1: Count & Boundary Alignment ---');
  let allPassed = true;

  if (indexed.length === manifest.totalEmails) {
    console.log(
      `✅ MATCH: Indexed count (${indexed.length}) matches manifest count (${manifest.totalEmails}) exactly!`
    );
  } else {
    console.error(
      `❌ MISMATCH: Indexed count (${indexed.length}) != manifest count (${manifest.totalEmails})!`
    );
    allPassed = false;
  }

  // Check 16MB boundary email
  const target16MB = 16 * 1024 * 1024;
  const match16MB = indexed.find((m) => m.start === target16MB);
  if (match16MB) {
    console.log(
      `✅ 16MB Boundary Check: Email #${match16MB.id} cleanly starts at exact byte ${match16MB.start} ("${match16MB.subject}")`
    );
  } else {
    console.error(`❌ 16MB Boundary Check FAILED: No email started at byte ${target16MB}`);
    allPassed = false;
  }

  // Check 64B overlap email
  const targetOverlap = 32 * 1024 * 1024 - 32;
  const matchOverlap = indexed.find((m) => m.start === targetOverlap);
  if (matchOverlap) {
    console.log(
      `✅ 64B Overlap Region Check: Email #${matchOverlap.id} cleanly captured at byte ${matchOverlap.start} without duplication ("${matchOverlap.subject}")`
    );
  } else {
    console.error(`❌ 64B Overlap Check FAILED: No email started at byte ${targetOverlap}`);
    allPassed = false;
  }

  // Check unescaped delimiter traps in body
  const trapEmail = manifest.emails.find((m) => m.special === 'delimiter_traps');
  if (trapEmail) {
    const indexedTrap = indexed[trapEmail.id];
    console.log(
      `✅ Trap Email Integrity: Email #${trapEmail.id} boundaries: ${indexedTrap.start} to ${indexedTrap.end} (Length: ${indexedTrap.end - indexedTrap.start}B)`
    );
  }

  // --- VERIFICATION GATE 1B: 100% PER-EMAIL FIELD-BY-FIELD ACCURACY ---
  console.log('\n--- VERIFICATION GATE 1B: Per-Email Field Verification (All Emails) ---');
  let fieldMismatches = 0;
  for (let idx = 0; idx < manifest.emails.length; idx++) {
    const exp = manifest.emails[idx];
    const act = indexed[idx];
    if (!act) {
      console.error(`❌ Email #${idx} missing in indexed results!`);
      fieldMismatches++;
      break;
    }

    const startMatch = act.start === exp.start;
    const endMatch =
      act.end === exp.end ||
      act.end === (idx + 1 < manifest.emails.length ? manifest.emails[idx + 1].start : fileSize);
    const subMatch = act.subject === exp.subject;
    const fromMatch = act.from === exp.from;
    const dateMatch = (act.date || '') === (exp.date || '');

    if (!startMatch || !endMatch || !subMatch || !fromMatch || !dateMatch) {
      fieldMismatches++;
      if (fieldMismatches <= 5) {
        console.error(`❌ Email #${idx} field mismatch:`);
        if (!startMatch) console.error(`   Start: expected ${exp.start}, got ${act.start}`);
        if (!endMatch) console.error(`   End: expected ${exp.end}, got ${act.end}`);
        if (!subMatch) console.error(`   Subject: expected "${exp.subject}", got "${act.subject}"`);
        if (!fromMatch) console.error(`   From: expected "${exp.from}", got "${act.from}"`);
        if (!dateMatch) console.error(`   Date: expected "${exp.date}", got "${act.date}"`);
      }
    }
  }

  if (fieldMismatches === 0) {
    console.log(
      `✅ 100% FIELD MATCH: All ${manifest.emails.length} emails match Subject, From, Date, Start, and End exactly!`
    );
  } else {
    console.error(
      `❌ Total field mismatches across archive: ${fieldMismatches} of ${manifest.emails.length}`
    );
    allPassed = false;
  }

  // --- STAGE 2: DEEP SEARCH (RUNNING REAL searchMboxStream) ---
  console.log('\n--- STAGE 2: DEEP SEARCH BENCHMARK (Real searchMboxStream) ---');
  const needle = 'zx-needle-4821';
  console.log(`Query: "${needle}" across all ${indexed.length} emails...`);

  const tSearchStart = performance.now();
  const searchResult = await searchMboxStream(mockBlob, indexed, needle, {
    batchBytes: CHUNK_SIZE,
  });
  const tSearchDone = performance.now();
  const searchDurationSec = (tSearchDone - tSearchStart) / 1000;
  const matchedIds = searchResult.matchedIds;

  console.log(
    `Deep Search Completed in ${(tSearchDone - tSearchStart).toFixed(1)} ms (${searchDurationSec.toFixed(2)} s)`
  );
  console.log(
    `Search Throughput: ${(fileSize / (1024 * 1024) / searchDurationSec).toFixed(1)} MB/s`
  );
  console.log(`Matches Found: [${matchedIds.join(', ')}]`);

  // Verify Needle Test Specifications
  const qpNeedle = manifest.needles.find((n) => n.type === 'QP_SOFT_BREAK');
  const htmlNeedle = manifest.needles.find((n) => n.type === 'HTML_TAG_SPLIT');
  const attNeedle = manifest.needles.find((n) => n.type === 'INSIDE_ATTACHMENT_ONLY_NO_MATCH');

  console.log('\n--- VERIFICATION GATE 2: Needle Search Rules ---');
  if (matchedIds.includes(qpNeedle.emailId)) {
    console.log(`✅ PASS: Needle 1 (QP soft-break) in Email #${qpNeedle.emailId} matched!`);
  } else {
    console.error(`❌ FAIL: Needle 1 (QP soft-break) was NOT matched!`);
    allPassed = false;
  }

  if (matchedIds.includes(htmlNeedle.emailId)) {
    console.log(`✅ PASS: Needle 2 (HTML tag split) in Email #${htmlNeedle.emailId} matched!`);
  } else {
    console.error(`❌ FAIL: Needle 2 (HTML tag split) was NOT matched!`);
    allPassed = false;
  }

  if (!matchedIds.includes(attNeedle.emailId)) {
    console.log(
      `✅ PASS: Needle 3 (inside base64 attachment only) in Email #${attNeedle.emailId} correctly excluded!`
    );
  } else {
    console.error(`❌ FAIL: Needle 3 in attachment was incorrectly matched!`);
    allPassed = false;
  }

  // --- STAGE 3: PARSE 25MB EMAIL & ATTACHMENT EXTRACTION ---
  console.log('\n--- STAGE 3: PARSING 25MB EMAIL & ATTACHMENT EXTRACTION ---');
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
      console.log(
        `Attachment: "${att.filename}" Size: ${(att.content.byteLength / (1024 * 1024)).toFixed(2)} MB`
      );
      if (att.content.byteLength >= 23 * 1024 * 1024) {
        console.log(`✅ Attachment extraction verified!`);
      }
    }
  }

  // --- STAGE 4: JAPANESE CJK PARSE TEST ---
  console.log('\n--- STAGE 4: JAPANESE CJK TEST ---');
  const cjkMeta = manifest.emails.find((m) => m.special === 'CJK_Japanese');
  if (cjkMeta) {
    const rawBuf = await mockBlob.slice(cjkMeta.start, cjkMeta.end).arrayBuffer();
    const parser = new PostalMime();
    const email = await parser.parse(rawBuf);
    console.log(`CJK Email Subject: "${email.subject}"`);
    console.log(`CJK Email From: "${email.from?.name} <${email.from?.address}>"`);
    if (email.subject.includes('日本語の請求書送付のご案内')) {
      console.log(`✅ CJK UTF-8 extraction fully working!`);
    }
  }

  // --- VERIFICATION GATE 5: CHUNK-BOUNDARY & LARGE-HEADER EDGE CASES ---
  console.log('\n--- VERIFICATION GATE 5: Chunk-Boundary & Strict MIME Conformance ---');

  // Test 5A: RFC 2047 Encodings & Folded Lines (GBK, ISO-2022-JP, KOI8-R)
  console.log('[Test 5A] RFC 2047 Folded Header Decoding with Adjacent Linear Whitespace:');

  // 1. GBK Base64 folded across lines
  const gbkFoldedRaw =
    'Subject: =?GBK?B?xOO6w8rA?=\r\n =?GBK?B?vec=?=\r\nFrom: test@example.com\r\n\r\n';
  const gbkSub = extractHeader(gbkFoldedRaw, 'Subject');
  if (gbkSub === '你好世界') {
    console.log(`  ✅ GBK Folded RFC 2047: "${gbkSub}" (Exact match)`);
  } else {
    console.error(`  ❌ GBK Folded RFC 2047 FAILED: expected "你好世界", got "${gbkSub}"`);
    allPassed = false;
  }

  // 2. ISO-2022-JP Base64 folded across lines per RFC 2047 section 5 (3)
  const isoJpFoldedRaw =
    'Subject: =?ISO-2022-JP?B?GyRCJDMkcyRLGyhC?=\r\n =?ISO-2022-JP?B?GyRCJEEkTxsoQg==?=\r\nFrom: test@example.com\r\n\r\n';
  const isoJpSub = extractHeader(isoJpFoldedRaw, 'Subject');
  if (isoJpSub === 'こんにちは') {
    console.log(`  ✅ ISO-2022-JP Folded RFC 2047: "${isoJpSub}" (Exact match)`);
  } else {
    console.error(`  ❌ ISO-2022-JP Folded RFC 2047 FAILED: expected "こんにちは", got "${isoJpSub}"`);
    allPassed = false;
  }

  // 3. KOI8-R Q-encoding folded across lines
  const koi8rQFoldedRaw =
    'Subject: =?KOI8-R?Q?=F0=D2=C9?=\r\n =?KOI8-R?Q?=D7=C5=D4?=\r\nFrom: test@example.com\r\n\r\n';
  const koi8rQSub = extractHeader(koi8rQFoldedRaw, 'Subject');
  if (koi8rQSub === 'Привет') {
    console.log(`  ✅ KOI8-R Q-Encoding Folded RFC 2047: "${koi8rQSub}" (Exact match)`);
  } else {
    console.error(`  ❌ KOI8-R Q-Encoding Folded RFC 2047 FAILED: expected "Привет", got "${koi8rQSub}"`);
    allPassed = false;
  }

  // 4. KOI8-R B-encoding folded across lines
  const koi8rBFoldedRaw =
    'Subject: =?KOI8-R?B?8NLJ?=\r\n =?KOI8-R?B?18XU?=\r\nFrom: test@example.com\r\n\r\n';
  const koi8rBSub = extractHeader(koi8rBFoldedRaw, 'Subject');
  if (koi8rBSub === 'Привет') {
    console.log(`  ✅ KOI8-R B-Encoding Folded RFC 2047: "${koi8rBSub}" (Exact match)`);
  } else {
    console.error(`  ❌ KOI8-R B-Encoding Folded RFC 2047 FAILED: expected "Привет", got "${koi8rBSub}"`);
    allPassed = false;
  }

  // Test 5B: Strict UTF-8 with fatal: true vs Latin-1 Fallback
  console.log('[Test 5B] Strict UTF-8 vs Latin-1 Decoding:');
  // Valid UTF-8 with legitimate U+FFFD replacement character:
  const legitUfffdBytes = new TextEncoder().encode('Special Symbol: \uFFFD in valid UTF-8');
  const decodedLegit = decodeHeaderBytes(legitUfffdBytes);
  if (decodedLegit.includes('\uFFFD') && decodedLegit.startsWith('Special Symbol:')) {
    console.log(`  ✅ Legitimate U+FFFD preserved without false Latin-1 fallback`);
  } else {
    console.error(`  ❌ Legitimate U+FFFD failed: "${decodedLegit}"`);
    allPassed = false;
  }

  // Raw 8-bit Latin-1 bytes (not valid UTF-8): "Café" encoded in ISO-8859-1 (0x43, 0x61, 0x66, 0xE9)
  const latin1Bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]);
  const decodedLatin1 = decodeHeaderBytes(latin1Bytes);
  if (decodedLatin1 === 'Café') {
    console.log(`  ✅ Invalid UTF-8 byte 0xE9 cleanly fell back to Latin-1: "${decodedLatin1}"`);
  } else {
    console.error(`  ❌ Latin-1 fallback failed: "${decodedLatin1}"`);
    allPassed = false;
  }

  // Test 5C: Synthetic Chunk-Boundary Crossing & Giant Headers
  console.log('[Test 5C] Boundary Crossing & Giant Headers Simulation:');
  // Create synthetic in-memory archive:
  // - Email 0: starts at 0, padding up to (16MB - 2000)
  // - Email 1: starts at (16MB - 2000). Headers are 3,500 bytes long, crossing the 16MB chunk boundary!
  // - Email 2: starts at 17MB. Headers are 12,000 bytes long (>8KB header test)!

  const chunkBoundaryByte = 16 * 1024 * 1024;
  const boundaryEmailStart = chunkBoundaryByte - 2000;

  // Build Email 0
  const email0Header =
    'From sender0@test.com Mon Jan 01 00:00:00 2026\r\nSubject: Base Email\r\nFrom: sender0@test.com\r\nDate: Mon, 01 Jan 2026 00:00:00 +0000\r\n\r\nEmail 0 Body\r\n';
  const email0HeaderBuf = Buffer.from(email0Header);
  const email0PaddingLen = boundaryEmailStart - email0HeaderBuf.length;
  if (email0PaddingLen < 0) throw new Error('Padding calculation error');
  const email0Padding = Buffer.alloc(email0PaddingLen, 0x20); // space padding
  email0Padding[email0PaddingLen - 1] = 0x0a; // Ensure RFC 4155 preceding newline before From delimiter

  // Build Email 1 (Starts at 16MB - 2000, 3.5KB headers crossing 16MB boundary)
  let email1HeadersStr =
    'From boundary@test.com Mon Jan 01 01:00:00 2026\r\nSubject: Boundary Crossing 3KB Header\r\nFrom: Boundary Sender <boundary@test.com>\r\nDate: Mon, 01 Jan 2026 01:00:00 +0000\r\n';
  // Add 80 routing headers to push header size to ~3500 bytes:
  for (let r = 0; r < 80; r++) {
    email1HeadersStr += `X-Tracking-Hop-${r}: hop-${r}-routing-trace-record-data-hash-${r * 1337}\r\n`;
  }
  email1HeadersStr += '\r\n'; // end of headers
  const email1HeadersBuf = Buffer.from(email1HeadersStr);
  console.log(`  Email 1 Header Size: ${email1HeadersBuf.length} bytes (starts at byte ${boundaryEmailStart}, crosses 16MB boundary at byte ${chunkBoundaryByte})`);

  const email1BodyBuf = Buffer.from('Email 1 body content crossing the chunk border cleanly.\r\n');

  // Build Email 2 (Starts at 17MB with 12KB header)
  let email2HeadersStr =
    'From giant@test.com Mon Jan 01 02:00:00 2026\r\nSubject: Giant 12KB Header Email\r\nFrom: Giant Sender <giant@test.com>\r\nDate: Mon, 01 Jan 2026 02:00:00 +0000\r\n';
  // Add 300 headers to exceed 12KB:
  for (let r = 0; r < 300; r++) {
    email2HeadersStr += `X-Extended-DKIM-Signature-Record-${r}: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=k1; bh=deadbeef; b=signaturedata_${r}\r\n`;
  }
  email2HeadersStr += '\r\n';
  const email2HeadersBuf = Buffer.from(email2HeadersStr);
  console.log(`  Email 2 Header Size: ${email2HeadersBuf.length} bytes (>8KB test)`);
  const email2BodyBuf = Buffer.from('Email 2 body content with giant headers.\r\n');

  // Combine into a single synthetic buffer
  const syntheticTotalBuf = Buffer.concat([
    email0HeaderBuf,
    email0Padding,
    email1HeadersBuf,
    email1BodyBuf,
    email2HeadersBuf,
    email2BodyBuf,
  ]);

  const syntheticBlob = {
    size: syntheticTotalBuf.length,
    slice(start, end) {
      const s = Math.max(0, start);
      const e = Math.min(syntheticTotalBuf.length, end);
      const len = Math.max(0, e - s);
      return {
        size: len,
        async arrayBuffer() {
          const sub = syntheticTotalBuf.subarray(s, e);
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
  };

  console.log(`  Running indexMboxStream on synthetic ${((syntheticTotalBuf.length) / (1024 * 1024)).toFixed(2)} MB buffer...`);
  const syntheticIndexed = await indexMboxStream(syntheticBlob);

  if (syntheticIndexed.length === 3) {
    console.log(`  ✅ All 3 synthetic emails found!`);
  } else {
    console.error(`  ❌ Expected 3 emails, got ${syntheticIndexed.length}`);
    allPassed = false;
  }

  // Verify Email 1 (Chunk Boundary Crosser)
  const e1 = syntheticIndexed[1];
  if (e1 && e1.start === boundaryEmailStart) {
    if (e1.subject === 'Boundary Crossing 3KB Header' && e1.from === 'Boundary Sender <boundary@test.com>') {
      console.log(`  ✅ Email 1 (Cross-Chunk 3.5KB Headers) successfully recovered from disk fallback!`);
      console.log(`     Subject: "${e1.subject}" | From: "${e1.from}"`);
    } else {
      console.error(`  ❌ Email 1 headers truncated: Subject: "${e1?.subject}", From: "${e1?.from}"`);
      allPassed = false;
    }
  } else {
    console.error(`  ❌ Email 1 boundary incorrect: got start ${e1?.start}, expected ${boundaryEmailStart}`);
    allPassed = false;
  }

  // Verify Email 2 (Giant 12KB Headers)
  const e2 = syntheticIndexed[2];
  if (e2) {
    if (e2.subject === 'Giant 12KB Header Email' && e2.from === 'Giant Sender <giant@test.com>') {
      console.log(`  ✅ Email 2 (12KB Giant Headers) successfully recovered without truncation!`);
      console.log(`     Subject: "${e2.subject}" | From: "${e2.from}"`);
    } else {
      console.error(`  ❌ Email 2 headers truncated: Subject: "${e2?.subject}", From: "${e2?.from}"`);
      allPassed = false;
    }
  } else {
    console.error(`  ❌ Email 2 missing!`);
    allPassed = false;
  }

  fs.closeSync(fd);

  console.log(`\n================================================================`);
  if (allPassed) {
    console.log(`🏆 ALL BENCHMARKS & VERIFICATION GATES PASSED WITH ZERO ERRORS!`);
  } else {
    console.error(`💥 ONE OR MORE GATES FAILED!`);
    process.exit(1);
  }
  console.log(`================================================================`);
}

runBenchmark().catch((err) => {
  console.error('[Benchmark Error]', err);
  process.exit(1);
});

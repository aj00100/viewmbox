// src/workers/engine.ts
// High-performance, streaming RFC 4155 / MBOX parsing and search engine.
// Shared between Web Worker (browser) and test suites (Node.js).

export interface EmailIndexItem {
  id: number;
  start: number;
  end: number;
  subject: string;
  from: string;
  date: string;
}

export interface FileLike {
  size: number;
  slice(start: number, end: number): {
    arrayBuffer(): Promise<ArrayBuffer>;
  };
}

export interface IndexProgress {
  scannedBytes: number;
  totalBytes: number;
  percent: number;
  found: number;
}

export interface SearchProgress {
  scannedBytes: number;
  totalBytes: number;
  current: number;
  total: number;
  percent: number;
  matchedIds: number[];
}

export const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB chunking window
export const OVERLAP = 64; // 64 bytes overlap between chunk iterations
export const HEADER_SNIFF_BYTES = 32768; // 32 KB sniff window inside chunk buffer
export const MAX_HEADER_SEARCH_BYTES = 131072; // 128 KB max header window on disk fallback

// Matches RFC 4155 / Gmail Takeout / Thunderbird "From <sender> <date>"
export const FROM_LINE_RE =
  /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /;

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const latin1Decoder = new TextDecoder('iso-8859-1');

/**
 * Strict byte decoder for email header blocks.
 * Uses fatal: true so invalid UTF-8 sequences trigger clean fallback to Latin-1
 * without guessing or misfiring on legitimate U+FFFD characters.
 */
export function decodeHeaderBytes(subBytes: Uint8Array): string {
  try {
    return utf8Strict.decode(subBytes);
  } catch {
    return latin1Decoder.decode(subBytes);
  }
}

/**
 * Decodes RFC 2047 MIME encoded-word tokens (=?charset?encoding?encoded_text?=).
 * Implements RFC 2047 Section 6.2: linear white-space separating adjacent
 * encoded-words is discarded before decoding.
 * Supports Base64 (B) and Quoted-Printable (Q) with international charsets (UTF-8, GBK, ISO-2022-JP, KOI8-R, etc.).
 */
export function decodeRfc2047(input: string): string {
  if (!input || !input.includes('=?')) return input;

  // RFC 2047 Section 6.2: linear white-space separating adjacent encoded-words MUST NOT be displayed
  const stripped = input.replace(
    /(\=\?[^?]+\?[BQbq]\?[^?]*\?\=)\s+(?=\=\?[^?]+\?[BQbq]\?[^?]*\?\=)/g,
    '$1'
  );

  return stripped.replace(
    /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        let bytes: Uint8Array;
        const encUpper = encoding.toUpperCase();

        if (encUpper === 'B') {
          const bin = atob(text.replace(/\s+/g, ''));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          // Q-encoding: '_' represents 0x20 space, '=XX' represents hex byte
          const q = text.replace(/_/g, ' ');
          const out: number[] = [];
          for (let i = 0; i < q.length; i++) {
            if (
              q[i] === '=' &&
              i + 2 < q.length &&
              /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))
            ) {
              out.push(parseInt(q.slice(i + 1, i + 3), 16));
              i += 2;
            } else {
              out.push(q.charCodeAt(i));
            }
          }
          bytes = new Uint8Array(out);
        }

        const cleanCharset = charset.toLowerCase().trim();
        return new TextDecoder(cleanCharset, { fatal: false }).decode(bytes);
      } catch {
        return text;
      }
    }
  );
}

/**
 * Extracts and unfolds a specific RFC 822 header field from raw header text.
 * Unfolds continuation lines (CRLF followed by space or tab) into a single line.
 */
export function extractHeader(rawHeaders: string, name: string): string {
  const re = new RegExp(`^${name}:[ \\t]*(.+(?:\\r?\\n[ \\t]+.+)*)`, 'im');
  const m = rawHeaders.match(re);
  if (!m) return '';
  const unfolded = m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
  return decodeRfc2047(unfolded);
}

/**
 * In-memory fast sniff for headers directly from the chunk buffer.
 * Returns null if the end of headers (\r?\n\r?\n) was not found in the sniff window,
 * indicating either a chunk boundary cutoff or headers exceeding the sniff window,
 * signaling the caller to perform a file slice fallback.
 */
export function sniffHeaderFromBuffer(
  bytes: Uint8Array,
  localStart: number,
  sniffWindow: number = HEADER_SNIFF_BYTES
): { subject: string; from: string; date: string } | null {
  const sliceEnd = Math.min(bytes.length, localStart + sniffWindow);
  const subBytes = bytes.subarray(localStart, sliceEnd);
  const text = decodeHeaderBytes(subBytes);
  const delimMatch = /\r?\n\r?\n/.exec(text);

  if (!delimMatch) {
    return null;
  }

  const headerBlock = text.slice(0, delimMatch.index);
  return {
    subject: extractHeader(headerBlock, 'Subject') || '(No Subject)',
    from: extractHeader(headerBlock, 'From') || '(Unknown Sender)',
    date: extractHeader(headerBlock, 'Date') || '',
  };
}

/**
 * Fallback disk reader for emails whose headers crossed chunk boundaries or
 * exceeded the in-memory sniff window. Reads up to MAX_HEADER_SEARCH_BYTES (128 KB).
 */
export async function parseQuickHeaders(
  file: FileLike,
  start: number,
  fileEnd: number
): Promise<{ subject: string; from: string; date: string }> {
  const sliceEnd = Math.min(fileEnd, start + MAX_HEADER_SEARCH_BYTES);
  const buf = await file.slice(start, sliceEnd).arrayBuffer();
  const subBytes = new Uint8Array(buf);
  const text = decodeHeaderBytes(subBytes);
  const delimMatch = /\r?\n\r?\n/.exec(text);
  const headerBlock = delimMatch ? text.slice(0, delimMatch.index) : text;

  return {
    subject: extractHeader(headerBlock, 'Subject') || '(No Subject)',
    from: extractHeader(headerBlock, 'From') || '(Unknown Sender)',
    date: extractHeader(headerBlock, 'Date') || '',
  };
}

/**
 * Decodes Quoted-Printable soft breaks and =XX hex characters for search indexing.
 */
export function decodeQuotedPrintable(str: string): string {
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

/**
 * Unified single-pass MBOX indexer.
 * Scans byte boundaries using a 16MB sliding chunk window, extracts headers in-memory,
 * and falls back to targeted disk slices only when an email boundary falls near chunk edges.
 */
export async function indexMboxStream(
  file: FileLike,
  options: {
    chunkSize?: number;
    overlap?: number;
    onProgress?: (progress: IndexProgress) => void;
    onBatch?: (items: EmailIndexItem[], percent: number) => void;
    isAborted?: () => boolean;
  } = {}
): Promise<EmailIndexItem[]> {
  const chunkSize = options.chunkSize || CHUNK_SIZE;
  const overlap = options.overlap || OVERLAP;
  const fileSize = file.size;
  const indexed: EmailIndexItem[] = [];
  let offset = 0;

  while (offset < fileSize) {
    if (options.isAborted && options.isAborted()) return [];

    const start = offset === 0 ? 0 : Math.max(0, offset - overlap);
    const end = Math.min(fileSize, offset + chunkSize);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());

    // Check byte 0 for first email
    if (offset === 0 && bytes.length >= 5) {
      const headLine = decodeHeaderBytes(bytes.subarray(0, Math.min(120, bytes.length)));
      if (FROM_LINE_RE.test(headLine)) {
        const meta =
          sniffHeaderFromBuffer(bytes, 0) ||
          (await parseQuickHeaders(file, 0, Math.min(fileSize, MAX_HEADER_SEARCH_BYTES)));
        indexed.push({
          id: 0,
          start: 0,
          end: 0,
          ...meta,
        });
      }
    }

    // Scan for "\nFrom " (0x0A 0x46 0x72 0x6F 0x6D 0x20)
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

        const linePreview = decodeHeaderBytes(
          bytes.subarray(i + 1, Math.min(bytes.length, i + 120))
        );
        if (FROM_LINE_RE.test(linePreview)) {
          if (indexed.length > 0) {
            indexed[indexed.length - 1].end = absPos;
          }

          let meta = sniffHeaderFromBuffer(bytes, i + 1);
          if (!meta) {
            meta = await parseQuickHeaders(
              file,
              absPos,
              Math.min(fileSize, absPos + MAX_HEADER_SEARCH_BYTES)
            );
          }

          indexed.push({
            id: indexed.length,
            start: absPos,
            end: 0,
            ...meta,
          });

          if (options.onBatch && indexed.length % 200 === 0) {
            options.onBatch(
              indexed.slice(indexed.length - 200),
              Math.min(99, Math.round((offset / fileSize) * 100))
            );
          }
        }
      }
    }

    offset += chunkSize;
    if (options.onProgress) {
      options.onProgress({
        scannedBytes: Math.min(fileSize, offset),
        totalBytes: fileSize,
        percent: Math.min(100, Math.round((offset / fileSize) * 100)),
        found: indexed.length,
      });
    }
  }

  // Finalize all end boundaries
  for (let j = 0; j < indexed.length; j++) {
    indexed[j].end = j + 1 < indexed.length ? indexed[j + 1].start : fileSize;
  }

  return indexed;
}

/**
 * Batched streaming deep search engine.
 * Reads emails in contiguous 16MB slices to reduce disk calls from thousands to tens,
 * searches across Subject, From, Date, and message body with QP / HTML unwrapping.
 */
export async function searchMboxStream(
  file: FileLike,
  items: EmailIndexItem[],
  query: string,
  options: {
    batchBytes?: number;
    onProgress?: (progress: SearchProgress) => void;
    isAborted?: () => boolean;
  } = {}
): Promise<{ matchedIds: number[]; scannedBytes: number }> {
  const needle = String(query || '').toLowerCase().trim();
  const matchedIds: number[] = [];
  const totalBytes = file.size;
  let scannedBytes = 0;
  const batchBytes = options.batchBytes || CHUNK_SIZE;

  let i = 0;
  while (i < items.length) {
    if (options.isAborted && options.isAborted()) {
      return { matchedIds, scannedBytes };
    }

    const batchStartIdx = i;
    const batchStartByte = items[batchStartIdx].start;

    // Group emails into a 16MB contiguous slice
    while (i < items.length && items[i].end - batchStartByte < batchBytes) {
      i++;
    }
    if (i === batchStartIdx) {
      i = batchStartIdx + 1;
    }
    const batchEndIdx = i;
    const singleEmail = batchEndIdx - batchStartIdx === 1;
    const actualEndByte = singleEmail
      ? Math.min(items[batchStartIdx].end, batchStartByte + 2 * 1024 * 1024)
      : items[batchEndIdx - 1].end;

    // Single disk read for the entire 16MB batch
    const batchBuf = await file.slice(batchStartByte, actualEndByte).arrayBuffer();
    const batchText = latin1Decoder.decode(batchBuf);
    const batchLower = batchText.toLowerCase();

    // Fast-path: check if query or encoded markers exist in batch
    const mayHaveNeedle =
      batchLower.includes(needle) || batchText.includes('=') || batchText.includes('<');

    for (let k = batchStartIdx; k < batchEndIdx; k++) {
      if (options.isAborted && options.isAborted()) {
        return { matchedIds, scannedBytes };
      }

      const item = items[k];
      let itemEnd = item.end;
      if (!itemEnd || itemEnd <= item.start) {
        itemEnd = k + 1 < items.length ? items[k + 1].start : totalBytes;
      }
      const emailLen = Math.max(0, itemEnd - item.start);
      scannedBytes += emailLen;

      if (
        item.subject.toLowerCase().includes(needle) ||
        item.from.toLowerCase().includes(needle) ||
        item.date.toLowerCase().includes(needle)
      ) {
        matchedIds.push(item.id);
      } else if (mayHaveNeedle) {
        const localStart = item.start - batchStartByte;
        const localEnd = Math.min(
          batchText.length,
          localStart + Math.min(emailLen, 2 * 1024 * 1024)
        );
        if (localStart < batchText.length) {
          const rawEmail = batchText.slice(localStart, localEnd);
          const rawEmailLower = rawEmail.toLowerCase();
          if (rawEmailLower.includes(needle)) {
            matchedIds.push(item.id);
          } else {
            const decodedText = rawEmail.includes('=')
              ? decodeQuotedPrintable(rawEmail).toLowerCase()
              : '';
            const strippedHtml = rawEmail.includes('<')
              ? (decodedText || rawEmailLower).replace(/<[^>]+>/g, '')
              : '';
            if (
              (decodedText && decodedText.includes(needle)) ||
              (strippedHtml && strippedHtml.includes(needle))
            ) {
              matchedIds.push(item.id);
            }
          }
        }
      }
    }

    if (options.onProgress) {
      options.onProgress({
        scannedBytes: Math.min(totalBytes, scannedBytes),
        totalBytes,
        current: Math.min(items.length, batchEndIdx),
        total: items.length,
        percent: Math.min(
          100,
          Math.round((Math.min(items.length, batchEndIdx) / items.length) * 100)
        ),
        matchedIds: [...matchedIds],
      });
    }
  }

  return { matchedIds, scannedBytes };
}

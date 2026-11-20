/// <reference lib="webworker" />

export interface EmailIndexItem {
  id: number;
  start: number;
  end: number;
  subject: string;
  from: string;
  date: string;
}

const CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB
const OVERLAP = 64;
const HEADER_SNIFF_BYTES = 3072; // 3 KB per email for fast sidebar index

// Matches RFC 4155 / Gmail Takeout / Thunderbird "From <sender> <date>"
const FROM_LINE_RE =
  /^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const latin1Decoder = new TextDecoder('iso-8859-1');

function decodeRfc2047(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        let bytes: Uint8Array;
        if (encoding.toUpperCase() === 'B') {
          const bin = atob(text.replace(/\s+/g, ''));
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          const q = text.replace(/_/g, ' ');
          const out: number[] = [];
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

function extractHeader(rawHeaders: string, name: string): string {
  const re = new RegExp(`^${name}:[ \\t]*(.+(?:\\r?\\n[ \\t]+.+)*)`, 'im');
  const m = rawHeaders.match(re);
  if (!m) return '';
  const unfolded = m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
  return decodeRfc2047(unfolded);
}

async function parseQuickHeaders(
  file: File,
  start: number,
  end: number
): Promise<{ subject: string; from: string; date: string }> {
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

let activeAbort = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, file, query, items } = e.data;

  if (type === 'ABORT') {
    activeAbort = true;
    return;
  }

  if (type === 'INDEX' && file instanceof File) {
    activeAbort = false;
    const fileSize = file.size;
    const boundaries: number[] = [];
    let offset = 0;

    while (offset < fileSize) {
      if (activeAbort) return;

      const start = offset === 0 ? 0 : Math.max(0, offset - OVERLAP);
      const end = Math.min(fileSize, offset + CHUNK_SIZE);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());

      // Check byte 0 for first email
      if (offset === 0 && bytes.length >= 5) {
        const headLine = utf8Decoder.decode(bytes.subarray(0, Math.min(120, bytes.length)));
        if (FROM_LINE_RE.test(headLine)) {
          boundaries.push(0);
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
          // Deduplicate overlap hits
          if (boundaries.length > 0 && absPos <= boundaries[boundaries.length - 1]) {
            continue;
          }
          const linePreview = utf8Decoder.decode(
            bytes.subarray(i + 1, Math.min(bytes.length, i + 120))
          );
          if (FROM_LINE_RE.test(linePreview)) {
            boundaries.push(absPos);
          }
        }
      }

      offset += CHUNK_SIZE;
      self.postMessage({
        type: 'PROGRESS',
        stage: 'scanning',
        percent: Math.min(100, Math.round((offset / fileSize) * 100)),
        found: boundaries.length,
      });
    }

    // Build lightweight header index in batches of 200
    const indexed: EmailIndexItem[] = [];
    for (let i = 0; i < boundaries.length; i++) {
      if (activeAbort) return;
      const msgStart = boundaries[i];
      const msgEnd = i + 1 < boundaries.length ? boundaries[i + 1] : fileSize;
      const meta = await parseQuickHeaders(file, msgStart, msgEnd);

      indexed.push({
        id: i,
        start: msgStart,
        end: msgEnd,
        ...meta,
      });

      if (indexed.length % 200 === 0 || i === boundaries.length - 1) {
        self.postMessage({
          type: 'BATCH',
          items: indexed.slice(indexed.length - (indexed.length % 200 || 200)),
          percent: Math.round(((i + 1) / boundaries.length) * 100),
        });
      }
    }

    self.postMessage({ type: 'DONE', total: boundaries.length });
  }

  // Optional Deep Body Search (streams on demand, never on keystroke)
  if (type === 'DEEP_SEARCH' && file instanceof File && Array.isArray(items)) {
    activeAbort = false;
    const needle = String(query || '').toLowerCase();
    const matchedIds: number[] = [];

    for (let i = 0; i < items.length; i++) {
      if (activeAbort) return;
      const item: EmailIndexItem = items[i];
      // Skip >15MB raw attachments during text search to keep it fast
      const readLen = Math.min(item.end - item.start, 2 * 1024 * 1024);
      const text = await file.slice(item.start, item.start + readLen).text();
      if (text.toLowerCase().includes(needle)) {
        matchedIds.push(item.id);
      }
      if (i % 100 === 0 || i === items.length - 1) {
        self.postMessage({
          type: 'SEARCH_PROGRESS',
          percent: Math.round(((i + 1) / items.length) * 100),
          matchedIds,
        });
      }
    }
    self.postMessage({ type: 'SEARCH_DONE', matchedIds });
  }
};

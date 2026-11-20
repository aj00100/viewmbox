/// <reference lib="webworker" />
import PostalMime from 'postal-mime';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface EmailIndexItem {
  id: number;
  start: number;
  end: number;
  subject: string;
  from: string;
  date: string;
}

export interface AttachmentMeta {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
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
  file: any,
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

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, '') // strip soft linebreaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _m;
      }
    });
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let activeAbort = false;

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;
  const { type } = data;

  if (type === 'ABORT') {
    activeAbort = true;
    return;
  }

  // 1. FILE INDEXING (Accepts any sliceable Blob/File)
  if (type === 'INDEX' && data.file && typeof data.file.slice === 'function') {
    activeAbort = false;
    const file = data.file;
    const fileSize = file.size;
    const boundaries: number[] = [];
    let offset = 0;

    try {
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
          scannedBytes: Math.min(fileSize, offset),
          totalBytes: fileSize,
          percent: Math.min(100, Math.round((offset / fileSize) * 100)),
          found: boundaries.length,
        });
      }

      if (boundaries.length === 0) {
        self.postMessage({ type: 'ERROR', message: 'No valid RFC 4155 email headers found in this file.' });
        return;
      }

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
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: `Worker indexing failed: ${err?.message || String(err)}` });
    }
    return;
  }

  // 2. PARSE & RENDER EMAIL IN WORKER (Zero Main-Thread Jank)
  if (type === 'RENDER_EMAIL' && data.file && typeof data.file.slice === 'function') {
    try {
      const { file, start, end, allowRemoteImages } = data;
      const rawBuffer = await file.slice(start, end).arrayBuffer();
      const parser = new PostalMime();
      const email = await parser.parse(rawBuffer);

      const cidMap = new Map<string, string>();
      const attachmentsMeta: AttachmentMeta[] = [];

      for (let i = 0; i < (email.attachments || []).length; i++) {
        const att = email.attachments[i];
        const isInline = Boolean(att.contentId);
        const size = att.content ? att.content.byteLength : 0;

        if (isInline && att.content && size < 5 * 1024 * 1024) {
          const base64 = uint8ArrayToBase64(new Uint8Array(att.content));
          const mime = att.mimeType || 'image/png';
          const cleanCid = att.contentId.replace(/^<|>$/g, '');
          cidMap.set(cleanCid, `data:${mime};base64,${base64}`);
        } else {
          attachmentsMeta.push({
            id: i,
            filename: att.filename || `attachment_${i + 1}.bin`,
            mimeType: att.mimeType || 'application/octet-stream',
            size,
          });
        }
      }

      let bodyHtml = email.html
        ? email.html
        : `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif;">${escapeHtml(
            email.text || '(Empty message)'
          )}</pre>`;

      for (const [cid, dataUri] of cidMap.entries()) {
        const escapedCid = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        bodyHtml = bodyHtml.replace(new RegExp(`cid:<?${escapedCid}>?`, 'gi'), dataUri);
      }

      const imgSrc = allowRemoteImages ? 'data: https: http:' : 'data:';
      const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; font-src data:;`;

      const srcdoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    body { margin: 16px; font-family: system-ui, -apple-system, sans-serif; color: #111827; line-height: 1.5; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;

      const fromStr = email.from
        ? `${email.from.name ? `${email.from.name} ` : ''}<${email.from.address || ''}>`
        : '(Unknown)';
      const toStr = (email.to || [])
        .map((t) => `${t.name ? `${t.name} ` : ''}<${t.address || ''}>`)
        .join(', ');

      self.postMessage({
        type: 'EMAIL_RENDERED',
        emailId: data.emailId,
        subject: email.subject || '(No Subject)',
        from: fromStr,
        to: toStr,
        date: email.date || '',
        text: email.text || '',
        srcdoc,
        bodyHtml,
        attachments: attachmentsMeta,
      });
    } catch (err: any) {
      self.postMessage({
        type: 'EMAIL_RENDER_ERROR',
        message: err?.message || 'Failed to render email',
      });
    }
    return;
  }

  // 3. LAZY ATTACHMENT EXTRACTION
  if (type === 'GET_ATTACHMENT' && data.file && typeof data.file.slice === 'function') {
    try {
      const { file, start, end, attachmentIndex } = data;
      const rawBuffer = await file.slice(start, end).arrayBuffer();
      const parser = new PostalMime();
      const email = await parser.parse(rawBuffer);
      const att = email.attachments?.[attachmentIndex];

      if (!att || !att.content) {
        throw new Error('Attachment content not found');
      }

      const buffer = att.content;
      self.postMessage(
        {
          type: 'ATTACHMENT_READY',
          filename: att.filename || 'attachment.bin',
          mimeType: att.mimeType || 'application/octet-stream',
          buffer,
        },
        [buffer]
      );
    } catch (err: any) {
      self.postMessage({
        type: 'ATTACHMENT_ERROR',
        message: err?.message || 'Failed to download attachment',
      });
    }
    return;
  }

  // 4. ON-DEMAND BODY SEARCH
  if (type === 'DEEP_SEARCH' && data.file && typeof data.file.slice === 'function' && Array.isArray(data.items)) {
    activeAbort = false;
    const file = data.file;
    const items: EmailIndexItem[] = data.items;
    const needle = String(data.query || '').toLowerCase().trim();
    const matchedIds: number[] = [];
    const totalBytes = file.size;
    let scannedBytes = 0;

    for (let i = 0; i < items.length; i++) {
      if (activeAbort) {
        self.postMessage({ type: 'SEARCH_ABORTED', matchedIds });
        return;
      }

      const item = items[i];
      const emailLen = item.end - item.start;
      scannedBytes += emailLen;

      if (
        item.subject.toLowerCase().includes(needle) ||
        item.from.toLowerCase().includes(needle) ||
        item.date.toLowerCase().includes(needle)
      ) {
        matchedIds.push(item.id);
      } else {
        const readLen = Math.min(emailLen, 2 * 1024 * 1024);
        const rawBuf = await file.slice(item.start, item.start + readLen).arrayBuffer();
        const rawText = latin1Decoder.decode(rawBuf);
        const decodedText = decodeQuotedPrintable(rawText).toLowerCase();

        if (decodedText.includes(needle)) {
          matchedIds.push(item.id);
        }
      }

      if (i % 50 === 0 || i === items.length - 1) {
        self.postMessage({
          type: 'SEARCH_PROGRESS',
          scannedBytes,
          totalBytes,
          current: i + 1,
          total: items.length,
          percent: Math.min(100, Math.round(((i + 1) / items.length) * 100)),
          matchedIds: [...matchedIds],
        });
      }
    }

    self.postMessage({
      type: 'SEARCH_DONE',
      matchedIds,
      totalScanned: items.length,
    });
    return;
  }

  // 5. DIRECT PDF EXPORT VIA PDF-LIB (Downloads directly to device Downloads folder)
  if (type === 'GENERATE_PDF') {
    try {
      const { subject, from, to, date, text } = data;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

      const pageWidth = 595.28; // A4
      const pageHeight = 841.89;
      const margin = 40;
      const contentWidth = pageWidth - margin * 2;

      let page = doc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - margin;

      // Blue accent banner
      page.drawRectangle({
        x: margin,
        y: y - 4,
        width: contentWidth,
        height: 4,
        color: rgb(0.145, 0.388, 0.922),
      });
      y -= 22;

      // Subject
      const subWords = (subject || '(No Subject)').split(' ');
      let subLine = '';
      for (const w of subWords) {
        const testSub = subLine ? subLine + ' ' + w : w;
        const cleanTest = testSub.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
        if (fontBold.widthOfTextAtSize(cleanTest, 15) > contentWidth && subLine) {
          page.drawText(subLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'), {
            x: margin,
            y,
            size: 15,
            font: fontBold,
            color: rgb(0.06, 0.09, 0.16),
          });
          y -= 18;
          subLine = w;
        } else {
          subLine = testSub;
        }
      }
      if (subLine) {
        page.drawText(subLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'), {
          x: margin,
          y,
          size: 15,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16),
        });
        y -= 20;
      }

      // Metadata
      const meta = [
        `From: ${from || 'Unknown'}`,
        `Date: ${date || 'Unknown'}`,
        to ? `To: ${to}` : null,
      ].filter(Boolean) as string[];

      for (const m of meta) {
        const cleanM = m.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').slice(0, 110);
        page.drawText(cleanM, {
          x: margin,
          y,
          size: 9,
          font,
          color: rgb(0.3, 0.35, 0.42),
        });
        y -= 13;
      }

      y -= 8;
      page.drawLine({
        start: { x: margin, y },
        end: { x: pageWidth - margin, y },
        thickness: 1,
        color: rgb(0.85, 0.88, 0.92),
      });
      y -= 20;

      // Body text wrapping
      const cleanBody = (text || 'No text content available.')
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, '    ');
      const rawLines = cleanBody.split('\n');

      for (const rawLine of rawLines) {
        const words = rawLine.split(' ');
        let line = '';

        for (const word of words) {
          const testLine = line ? line + ' ' + word : word;
          const sanitizedTest = testLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
          const width = font.widthOfTextAtSize(sanitizedTest, 10);

          if (width > contentWidth && line) {
            if (y < margin + 30) {
              page = doc.addPage([pageWidth, pageHeight]);
              y = pageHeight - margin;
            }
            const cleanLine = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
            page.drawText(cleanLine, { x: margin, y, size: 10, font, color: rgb(0.1, 0.15, 0.2) });
            y -= 14;
            line = word;
          } else {
            line = testLine;
          }
        }

        if (line) {
          if (y < margin + 30) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          const cleanLine = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
          page.drawText(cleanLine, { x: margin, y, size: 10, font, color: rgb(0.1, 0.15, 0.2) });
          y -= 14;
        }
      }

      const pdfBytes = await doc.save();
      const buffer = pdfBytes.buffer;
      self.postMessage(
        {
          type: 'PDF_READY',
          subject: subject || 'email',
          buffer,
        },
        [buffer]
      );
    } catch (err: any) {
      self.postMessage({
        type: 'PDF_ERROR',
        message: err?.message || 'Failed to generate PDF',
      });
    }
    return;
  }

  self.postMessage({ type: 'ERROR', message: `Unhandled worker message type: ${type}` });
};

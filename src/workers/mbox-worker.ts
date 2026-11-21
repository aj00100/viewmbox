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

function htmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sniffHeaderFromBuffer(
  bytes: Uint8Array,
  localStart: number
): { subject: string; from: string; date: string } {
  const sliceEnd = Math.min(bytes.length, localStart + HEADER_SNIFF_BYTES);
  const text = latin1Decoder.decode(bytes.subarray(localStart, sliceEnd));
  const headerBlock = text.split(/\r?\n\r?\n/, 1)[0] || text;
  return {
    subject: extractHeader(headerBlock, 'Subject') || '(No Subject)',
    from: extractHeader(headerBlock, 'From') || '(Unknown Sender)',
    date: extractHeader(headerBlock, 'Date') || '',
  };
}

let activeAbort = false;
let currentSearchSessionId = 0;
let cachedIndex: EmailIndexItem[] = [];

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;
  const { type } = data;

  if (type === 'ABORT') {
    activeAbort = true;
    currentSearchSessionId++;
    return;
  }

  // 1. FILE INDEXING (Unified single-pass boundary scan + in-memory header decoding)
  if (type === 'INDEX' && data.file && typeof data.file.slice === 'function') {
    activeAbort = false;
    const file = data.file;
    const fileSize = file.size;
    const indexed: EmailIndexItem[] = [];
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
            const meta = sniffHeaderFromBuffer(bytes, 0);
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
            const linePreview = utf8Decoder.decode(
              bytes.subarray(i + 1, Math.min(bytes.length, i + 120))
            );
            if (FROM_LINE_RE.test(linePreview)) {
              // Immediately update previous email's end boundary!
              if (indexed.length > 0) {
                indexed[indexed.length - 1].end = absPos;
              }

              let meta;
              const available = bytes.length - (i + 1);
              if (available >= 500) {
                meta = sniffHeaderFromBuffer(bytes, i + 1);
              } else {
                meta = await parseQuickHeaders(file, absPos, Math.min(fileSize, absPos + HEADER_SNIFF_BYTES));
              }

              indexed.push({
                id: indexed.length,
                start: absPos,
                end: 0,
                ...meta,
              });

              if (indexed.length % 200 === 0) {
                self.postMessage({
                  type: 'BATCH',
                  items: indexed.slice(indexed.length - 200),
                  percent: Math.min(99, Math.round((offset / fileSize) * 100)),
                });
              }
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
          found: indexed.length,
        });
      }

      if (indexed.length === 0) {
        self.postMessage({ type: 'ERROR', message: 'No valid RFC 4155 email headers found in this file.' });
        return;
      }

      // Finalize all end boundaries in one instant in-memory loop
      for (let j = 0; j < indexed.length; j++) {
        indexed[j].end = j + 1 < indexed.length ? indexed[j + 1].start : fileSize;
      }

      cachedIndex = indexed;

      // Flush final complete batch and post DONE with full validated items array
      self.postMessage({
        type: 'DONE',
        total: indexed.length,
        items: indexed,
      });
    } catch (err: any) {
      self.postMessage({ type: 'ERROR', message: `Worker indexing failed: ${err?.message || String(err)}` });
    }
    return;
  }

  // 2. PARSE & RENDER EMAIL IN WORKER (Zero Main-Thread Jank)
  if (type === 'RENDER_EMAIL' && data.file && typeof data.file.slice === 'function') {
    try {
      let { file, start, end, allowRemoteImages, emailId } = data;

      // Defensive check: if end boundary is missing or corrupt, recover from cached index
      if (!end || end <= start) {
        const cached = cachedIndex[emailId];
        if (cached && cached.end > cached.start) {
          end = cached.end;
        } else {
          end = Math.min(file.size, start + 10 * 1024 * 1024);
        }
      }
      const rawBuffer = await file.slice(start, end).arrayBuffer();
      const parser = new PostalMime();
      const email = await parser.parse(rawBuffer);

      const cidMap = new Map<string, string>();
      const attachmentsMeta: AttachmentMeta[] = [];
      const inlineImages: { name: string; mimeType: string; bytes: Uint8Array }[] = [];

      for (let i = 0; i < (email.attachments || []).length; i++) {
        const att = email.attachments[i];
        const isInline = Boolean(att.contentId) || att.disposition === 'inline' || Boolean(att.related);
        const isImage = (att.mimeType || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(att.filename || '');
        const size = att.content ? att.content.byteLength : 0;

        if (isInline && att.content && size < 5 * 1024 * 1024) {
          const uint8 = new Uint8Array(att.content);
          const mime = att.mimeType || 'image/png';
          if (att.contentId) {
            const base64 = uint8ArrayToBase64(uint8);
            const cleanCid = att.contentId.replace(/^<|>$/g, '');
            cidMap.set(cleanCid, `data:${mime};base64,${base64}`);
          }
          if (isImage) {
            inlineImages.push({
              name: att.filename || 'image.png',
              mimeType: mime,
              bytes: uint8,
            });
          }
          if (!att.contentId) {
            attachmentsMeta.push({
              id: i,
              filename: att.filename || `attachment_${i + 1}.bin`,
              mimeType: att.mimeType || 'application/octet-stream',
              size,
            });
          }
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

      const plainText = (email.text || '').trim() || htmlToPlainText(email.html || '');

      self.postMessage({
        type: 'EMAIL_RENDERED',
        emailId: data.emailId,
        subject: email.subject || '(No Subject)',
        from: fromStr,
        to: toStr,
        date: email.date || '',
        text: plainText,
        srcdoc,
        bodyHtml,
        attachments: attachmentsMeta,
        inlineImages,
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

  // 4. ON-DEMAND BODY SEARCH (Batched 16MB Chunked Streaming — 50X Speedup on Mobile)
  if (type === 'DEEP_SEARCH' && data.file && typeof data.file.slice === 'function') {
    const searchSessionId = ++currentSearchSessionId;
    activeAbort = false;
    const file = data.file;
    const items: EmailIndexItem[] =
      cachedIndex && cachedIndex.length > 0
        ? cachedIndex
        : Array.isArray(data.items)
          ? data.items
          : [];
    const needle = String(data.query || '').toLowerCase().trim();
    const matchedIds: number[] = [];
    const totalBytes = file.size;
    let scannedBytes = 0;
    const BATCH_BYTES = 16 * 1024 * 1024; // 16MB streaming batch

    let i = 0;
    while (i < items.length) {
      if (searchSessionId !== currentSearchSessionId || activeAbort) {
        self.postMessage({ type: 'SEARCH_ABORTED', searchSessionId, matchedIds });
        return;
      }

      const batchStartIdx = i;
      const batchStartByte = items[batchStartIdx].start;

      // Group emails into a 16MB contiguous slice
      while (i < items.length && (items[i].end - batchStartByte) < BATCH_BYTES) {
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

      // SINGLE DISK READ for this entire batch:
      const batchBuf = await file.slice(batchStartByte, actualEndByte).arrayBuffer();
      const batchText = latin1Decoder.decode(batchBuf);
      const batchLower = batchText.toLowerCase();

      // Fast-path: if needle is nowhere in batch and no QP/HTML markers, check headers only
      const mayHaveNeedle = batchLower.includes(needle) || batchText.includes('=') || batchText.includes('<');

      for (let k = batchStartIdx; k < batchEndIdx; k++) {
        if (searchSessionId !== currentSearchSessionId || activeAbort) {
          self.postMessage({ type: 'SEARCH_ABORTED', searchSessionId, matchedIds });
          return;
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
          const localEnd = Math.min(batchText.length, localStart + Math.min(emailLen, 2 * 1024 * 1024));
          if (localStart < batchText.length) {
            const rawEmail = batchText.slice(localStart, localEnd);
            const rawEmailLower = rawEmail.toLowerCase();
            if (rawEmailLower.includes(needle)) {
              matchedIds.push(item.id);
            } else {
              const decodedText = rawEmail.includes('=') ? decodeQuotedPrintable(rawEmail).toLowerCase() : '';
              const strippedHtml = rawEmail.includes('<') ? (decodedText || rawEmailLower).replace(/<[^>]+>/g, '') : '';
              if ((decodedText && decodedText.includes(needle)) || (strippedHtml && strippedHtml.includes(needle))) {
                matchedIds.push(item.id);
              }
            }
          }
        }
      }

      // Send progress after each 16MB batch
      self.postMessage({
        type: 'SEARCH_PROGRESS',
        searchSessionId,
        scannedBytes: Math.min(totalBytes, scannedBytes),
        totalBytes,
        current: Math.min(items.length, batchEndIdx),
        total: items.length,
        percent: Math.min(100, Math.round((Math.min(items.length, batchEndIdx) / items.length) * 100)),
        matchedIds: [...matchedIds],
      });
    }

    if (searchSessionId !== currentSearchSessionId || activeAbort) return;
    self.postMessage({
      type: 'SEARCH_DONE',
      searchSessionId,
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

      const pageWidth = 595.28; // Standard A4 portrait width
      const pageHeight = 841.89; // Standard A4 portrait height
      const margin = 48; // ~17mm standard document margin
      const contentWidth = pageWidth - margin * 2;

      let page = doc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - margin - 10;

      // Subject (20px bold title)
      const subWords = (subject || '(No Subject)').split(' ');
      let subLine = '';
      for (const w of subWords) {
        const testSub = subLine ? subLine + ' ' + w : w;
        const cleanTest = testSub.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
        if (fontBold.widthOfTextAtSize(cleanTest, 18) > contentWidth && subLine) {
          page.drawText(subLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'), {
            x: margin,
            y,
            size: 18,
            font: fontBold,
            color: rgb(0.06, 0.09, 0.16),
          });
          y -= 22;
          subLine = w;
        } else {
          subLine = testSub;
        }
      }
      if (subLine) {
        page.drawText(subLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'), {
          x: margin,
          y,
          size: 18,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16),
        });
        y -= 24;
      }

      // Metadata (Clean 10px sans-serif lines)
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
          size: 10,
          font,
          color: rgb(0.3, 0.35, 0.42),
        });
        y -= 15;
      }

      y -= 6;
      page.drawLine({
        start: { x: margin, y },
        end: { x: pageWidth - margin, y },
        thickness: 1.5,
        color: rgb(0.85, 0.88, 0.92),
      });
      y -= 20;

      // Draw inline logos / images if present in email
      const inlineImages = (data.inlineImages || []) as { name: string; mimeType: string; bytes: any }[];
      for (const imgData of inlineImages) {
        try {
          if (!imgData || !imgData.bytes) continue;
          let rawBytes: Uint8Array;
          if (imgData.bytes instanceof Uint8Array) {
            rawBytes = imgData.bytes;
          } else if (imgData.bytes instanceof ArrayBuffer) {
            rawBytes = new Uint8Array(imgData.bytes);
          } else if (ArrayBuffer.isView(imgData.bytes)) {
            rawBytes = new Uint8Array(imgData.bytes.buffer, imgData.bytes.byteOffset, imgData.bytes.byteLength);
          } else if (typeof imgData.bytes === 'object') {
            rawBytes = new Uint8Array(Object.values(imgData.bytes));
          } else {
            continue;
          }

          if (rawBytes.byteLength === 0) continue;

          // Check format: PNG or JPEG
          const isPng =
            (rawBytes.length >= 4 && rawBytes[0] === 0x89 && rawBytes[1] === 0x50 && rawBytes[2] === 0x4e && rawBytes[3] === 0x47) ||
            imgData.mimeType?.includes('png') ||
            imgData.name?.toLowerCase().endsWith('.png');

          const isJpg =
            (rawBytes.length >= 3 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8 && rawBytes[2] === 0xff) ||
            imgData.mimeType?.includes('jpeg') ||
            imgData.mimeType?.includes('jpg') ||
            imgData.name?.toLowerCase().endsWith('.jpg') ||
            imgData.name?.toLowerCase().endsWith('.jpeg');

          if (!isPng && !isJpg) {
            // pdf-lib directly supports only PNG and JPEG
            continue;
          }

          const embedded = isPng
            ? await doc.embedPng(rawBytes)
            : await doc.embedJpg(rawBytes);

          const dims = embedded.scale(1);
          let targetW = dims.width;
          let targetH = dims.height;
          if (!targetW || !targetH) continue;

          const maxW = Math.min(220, contentWidth);
          const maxH = 70;

          if (targetW > maxW) {
            const ratio = maxW / targetW;
            targetW = maxW;
            targetH = targetH * ratio;
          }
          if (targetH > maxH) {
            const ratio = maxH / targetH;
            targetH = maxH;
            targetW = targetW * ratio;
          }

          if (y - targetH < margin + 40) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin - 15;
          }

          page.drawImage(embedded, {
            x: margin,
            y: y - targetH,
            width: targetW,
            height: targetH,
          });
          y -= targetH + 16;
        } catch (imgErr) {
          console.warn('[PDF] Failed to embed image:', imgErr);
        }
      }

      // Body text wrapping
      const cleanBody = (text || 'No text content available.')
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, '    ');
      const rawLines = cleanBody.split('\n');

      for (const rawLine of rawLines) {
        if (!rawLine.trim()) {
          y -= 8;
          if (y < margin + 20) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          continue;
        }

        const words = rawLine.split(' ');
        let line = '';

        for (const word of words) {
          const testLine = line ? line + ' ' + word : word;
          const sanitizedTest = testLine.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
          const width = font.widthOfTextAtSize(sanitizedTest, 11);

          if (width > contentWidth && line) {
            if (y < margin + 20) {
              page = doc.addPage([pageWidth, pageHeight]);
              y = pageHeight - margin;
            }
            const cleanLine = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
            page.drawText(cleanLine, { x: margin, y, size: 11, font, color: rgb(0.12, 0.16, 0.22) });
            y -= 16;
            line = word;
          } else {
            line = testLine;
          }
        }

        if (line) {
          if (y < margin + 20) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
          }
          const cleanLine = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
          page.drawText(cleanLine, { x: margin, y, size: 11, font, color: rgb(0.12, 0.16, 0.22) });
          y -= 16;
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

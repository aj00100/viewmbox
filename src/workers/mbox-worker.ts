/// <reference lib="webworker" />
import PostalMime from 'postal-mime';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  type EmailIndexItem,
  indexMboxStream,
  searchMboxStream,
} from './engine';

export type { EmailIndexItem };

export interface AttachmentMeta {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
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

  // 1. FILE INDEXING (Using shared streaming engine)
  if (type === 'INDEX' && data.file && typeof data.file.slice === 'function') {
    activeAbort = false;
    const file = data.file;

    try {
      const indexed = await indexMboxStream(file, {
        onProgress: (p) => {
          self.postMessage({
            type: 'PROGRESS',
            stage: 'scanning',
            scannedBytes: p.scannedBytes,
            totalBytes: p.totalBytes,
            percent: p.percent,
            found: p.found,
          });
        },
        onBatch: (items, percent) => {
          self.postMessage({
            type: 'BATCH',
            items,
            percent,
          });
        },
        isAborted: () => activeAbort,
      });

      if (activeAbort) return;

      if (indexed.length === 0) {
        self.postMessage({
          type: 'ERROR',
          message: 'No valid RFC 4155 email headers found in this file.',
        });
        return;
      }

      cachedIndex = indexed;

      self.postMessage({
        type: 'DONE',
        total: indexed.length,
        items: indexed,
      });
    } catch (err: any) {
      self.postMessage({
        type: 'ERROR',
        message: `Worker indexing failed: ${err?.message || String(err)}`,
      });
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

  // 4. ON-DEMAND BODY SEARCH (Using shared batched engine)
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
    const query = String(data.query || '');

    try {
      const result = await searchMboxStream(file, items, query, {
        onProgress: (p) => {
          if (searchSessionId !== currentSearchSessionId || activeAbort) return;
          self.postMessage({
            type: 'SEARCH_PROGRESS',
            searchSessionId,
            scannedBytes: p.scannedBytes,
            totalBytes: p.totalBytes,
            current: p.current,
            total: p.total,
            percent: p.percent,
            matchedIds: p.matchedIds,
          });
        },
        isAborted: () => searchSessionId !== currentSearchSessionId || activeAbort,
      });

      if (searchSessionId !== currentSearchSessionId || activeAbort) {
        self.postMessage({
          type: 'SEARCH_ABORTED',
          searchSessionId,
          matchedIds: result.matchedIds,
        });
        return;
      }

      self.postMessage({
        type: 'SEARCH_DONE',
        searchSessionId,
        matchedIds: result.matchedIds,
        totalScanned: items.length,
      });
    } catch (err: any) {
      self.postMessage({
        type: 'ERROR',
        message: `Search failed: ${err?.message || String(err)}`,
      });
    }
    return;
  }

  // 5. DIRECT PDF EXPORT VIA PDF-LIB
  if (type === 'GENERATE_PDF') {
    try {
      const { subject, from, to, date, text } = data;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const margin = 48;
      const contentWidth = pageWidth - margin * 2;

      let page = doc.addPage([pageWidth, pageHeight]);
      let y = pageHeight - margin - 10;

      // Subject
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

      // Draw inline images
      const inlineImages = (data.inlineImages || []) as {
        name: string;
        mimeType: string;
        bytes: any;
      }[];
      for (const imgData of inlineImages) {
        try {
          if (!imgData || !imgData.bytes) continue;
          let rawBytes: Uint8Array;
          if (imgData.bytes instanceof Uint8Array) {
            rawBytes = imgData.bytes;
          } else if (imgData.bytes instanceof ArrayBuffer) {
            rawBytes = new Uint8Array(imgData.bytes);
          } else if (ArrayBuffer.isView(imgData.bytes)) {
            rawBytes = new Uint8Array(
              imgData.bytes.buffer,
              imgData.bytes.byteOffset,
              imgData.bytes.byteLength
            );
          } else if (typeof imgData.bytes === 'object') {
            rawBytes = new Uint8Array(Object.values(imgData.bytes));
          } else {
            continue;
          }

          if (rawBytes.byteLength === 0) continue;

          const isPng =
            (rawBytes.length >= 4 &&
              rawBytes[0] === 0x89 &&
              rawBytes[1] === 0x50 &&
              rawBytes[2] === 0x4e &&
              rawBytes[3] === 0x47) ||
            imgData.mimeType?.includes('png') ||
            imgData.name?.toLowerCase().endsWith('.png');

          const isJpg =
            (rawBytes.length >= 3 &&
              rawBytes[0] === 0xff &&
              rawBytes[1] === 0xd8 &&
              rawBytes[2] === 0xff) ||
            imgData.mimeType?.includes('jpeg') ||
            imgData.mimeType?.includes('jpg') ||
            imgData.name?.toLowerCase().endsWith('.jpg') ||
            imgData.name?.toLowerCase().endsWith('.jpeg');

          if (!isPng && !isJpg) {
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
            page.drawText(cleanLine, {
              x: margin,
              y,
              size: 11,
              font,
              color: rgb(0.12, 0.16, 0.22),
            });
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
          page.drawText(cleanLine, {
            x: margin,
            y,
            size: 11,
            font,
            color: rgb(0.12, 0.16, 0.22),
          });
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

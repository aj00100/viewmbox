import PostalMime from 'postal-mime';

export interface RenderedEmail {
  subject: string;
  from: string;
  to: string;
  date: string;
  srcdoc: string;
  attachments: Array<{ filename: string; mimeType: string; size: number; url: string }>;
}

const activeBlobUrls: string[] = [];

export function revokeActiveBlobUrls(): void {
  while (activeBlobUrls.length > 0) {
    const url = activeBlobUrls.pop();
    if (url) URL.revokeObjectURL(url);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function renderEmailFromSlice(
  file: File,
  start: number,
  end: number,
  allowRemoteImages = false
): Promise<RenderedEmail> {
  revokeActiveBlobUrls();

  // Pass raw ArrayBuffer so postal-mime handles ISO-8859-1 / Windows-1252 / UTF-8 natively
  const rawBuffer = await file.slice(start, end).arrayBuffer();
  const parser = new PostalMime();
  const email = await parser.parse(rawBuffer);

  const cidMap = new Map<string, string>();
  const attachments: RenderedEmail['attachments'] = [];

  for (const att of email.attachments || []) {
    const blob = new Blob([att.content], { type: att.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    activeBlobUrls.push(url);

    if (att.contentId) {
      const cleanCid = att.contentId.replace(/^<|>$/g, '');
      cidMap.set(cleanCid, url);
    }

    attachments.push({
      filename: att.filename || 'attachment.bin',
      mimeType: att.mimeType || 'application/octet-stream',
      size: blob.size,
      url,
    });
  }

  let bodyHtml = email.html
    ? email.html
    : `<pre style="white-space:pre-wrap;font-family:system-ui,sans-serif;">${escapeHtml(
        email.text || '(Empty message)'
      )}</pre>`;

  // Rewrite cid: inline images to local Blob URLs
  for (const [cid, blobUrl] of cidMap.entries()) {
    const escapedCid = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    bodyHtml = bodyHtml.replace(new RegExp(`cid:${escapedCid}`, 'gi'), blobUrl);
  }

  const imgSrc = allowRemoteImages ? 'data: blob: https: http:' : 'data: blob:';
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

  return {
    subject: email.subject || '(No Subject)',
    from: fromStr,
    to: toStr,
    date: email.date || '',
    srcdoc,
    attachments,
  };
}

export function downloadRawEml(file: File, start: number, end: number, subject: string): void {
  const blob = file.slice(start, end, 'message/rfc822');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (subject || 'email').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
  a.href = url;
  a.download = `${safeName}.eml`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

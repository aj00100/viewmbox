# ViewMBOX

> **100% In-Browser Streaming MBOX & Google Takeout Viewer**  
> Open, search, and export multi-gigabyte `.mbox` email archives locally in your browser. Zero software installation, zero cloud uploads, 100% offline-safe.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-viewmbox.pages.dev-blue?style=flat-square)](https://viewmbox.pages.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

---

## The Problem

When you export your email from **Google Takeout** (Gmail), Mozilla Thunderbird, or Apple Mail, you receive a monolithic `.mbox` archive often ranging from 500MB to 20GB+.

Existing web tools fail in two major ways:
1. **Out-of-Memory Crashes:** Most tools call `file.arrayBuffer()` or read the whole archive into a string, instantly crashing the browser tab on files larger than 50MB.
2. **Privacy Violations:** Cloud converters require uploading sensitive personal, financial, or corporate emails to third-party servers.
3. **Desktop Friction:** Most guides instruct non-technical users to install desktop email clients like Mozilla Thunderbird with legacy extensions just to inspect an archive.

## The Solution

**ViewMBOX** runs an in-browser streaming parser that processes multi-gigabyte files locally on your device:

- **16MB Windowed Streaming:** Uses `File.slice()` with a 64-byte boundary overlap in a background Web Worker. Maintains a flat ~20MB RAM footprint whether parsing 50MB or 20GB.
- **Zero Server Uploads:** 100% client-side execution. Your emails never touch a server, proxy, or cloud storage.
- **100% Offline Capability:** The worker is compiled as an inline in-memory Blob URL. The application works completely offline in Airplane Mode.
- **Tracking Pixel Protection:** HTML emails render inside a sandboxed `<iframe>` with a strict Content Security Policy (`default-src 'none'; img-src data: blob:;`) blocking tracking beacons by default.
- **Dual-Engine PDF Export:** Export individual messages as pixel-perfect visual PDFs (preserving responsive email templates, tables, and brand logos) or clean vector PDFs.
- **Attachment Extraction:** Extract images, PDFs, spreadsheets, and ZIP archives directly to your Downloads folder with one click.

---

## Supported Formats & Email Clients

- **Google Takeout:** Gmail archive exports (`Takeout/Mail/All mail Including Spam and Trash.mbox`)
- **Mozilla Thunderbird:** Profile mailbox files (`ImapMail`, `Mail/Local Folders`)
- **Apple Mail:** Mailbox exports (`.mbox` packages)
- **Legacy Unix Mailboxes:** Eudora, Opera Mail, Pine, Mutt
- **Standard:** RFC 4155 mbox format and RFC 822 / RFC 2822 / RFC 5322 MIME messages

---

## Verified Benchmarks (Physical Android Mobile Device)

All benchmarks measured inside mobile Google Chrome running on a physical Android device:

| Archive Type | File Size | Emails Indexed | Ingestion Time | Throughput |
| :--- | :--- | :--- | :--- | :--- |
| **Real Google Takeout** | 23.8 MB | 571 emails | 0.88 s | 27.0 MB/s |
| **Synthetic Stress Archive** | 500.0 MB | 3,778 emails | 11.80 s | 42.4 MB/s |
| **Synthetic Scaling Archive** | 2.00 GB | 16,134 emails | 44.36 s | 46.2 MB/s |
| **Airplane Mode (Offline)** | 2.00 GB | 16,134 emails | 44.36 s | 46.2 MB/s |

---

## Tech Stack

- **Framework:** [Astro](https://astro.build/) (Static MPA, zero client runtime bloat)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Threading:** Background Web Worker (`src/workers/mbox-worker.ts`)
- **MIME Parsing:** [`postal-mime`](https://github.com/postalsys/postal-mime) for zero-copy RFC 822 decoding
- **PDF Generation:** [`pdf-lib`](https://github.com/Hopding/pdf-lib) & Blink native print engine
- **Hosting:** Cloudflare Pages ($0 server cost forever)

---

## Getting Started

### Prerequisites

- Node.js 18+ (tested up to Node v24)
- npm or pnpm

### Installation

```bash
git clone https://github.com/aj00100/viewmbox.git
cd viewmbox
npm install
```

### Development Server

```bash
npm run dev
```

Visit `http://localhost:4321` in your browser.

### Production Build & Preview

```bash
npm run build
npm run preview
```

### Deployment

Deploy static assets directly to Cloudflare Pages:

```bash
./scripts/deploy.sh
```

---

## Privacy & Security Guarantee

1. **Zero Data Transmission:** No email subject, body, header, contact, or attachment is ever sent across the network.
2. **Zero Third-Party Trackers:** No analytics beacons, tracking cookies, or behavioral ad scripts run on reading views.
3. **Session Ephemeral:** Closing the browser tab clears all indexed offset tables from system memory immediately.

---

## License

MIT © [aj00100](https://github.com/aj00100)

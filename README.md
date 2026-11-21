# ViewMBOX

> **100% In-Browser Streaming MBOX & Google Takeout Viewer**  
> Open, search, and export multi-gigabyte `.mbox` email archives directly in your browser. Zero software to install, zero file uploads, 100% offline-safe.

👉 **Use the Web App:** [**viewmbox.pages.dev**](https://viewmbox.pages.dev)

---

## Overview

When you export your emails from **Google Takeout** (Gmail), Mozilla Thunderbird, or Apple Mail, you receive a monolithic `.mbox` archive often ranging from 500MB to 20GB+.

Existing web tools fail in two major ways:
1. **Out-of-Memory Crashes:** Generic online viewers attempt to load the entire archive into browser memory at once, crashing the tab on files over 50MB.
2. **Cloud Privacy Liabilities:** Commercial converters require uploading sensitive personal, financial, or legal emails to remote cloud servers.
3. **Desktop Hassle:** Most guides force users to install bulky desktop software like Mozilla Thunderbird with third-party extensions just to read an old email.

**ViewMBOX** solves this purely in the browser with an advanced streaming engine:

- **16MB Windowed Streaming:** Scans archives in 16MB slices in a background Web Worker. Maintains a flat ~20MB RAM footprint whether parsing a 50MB file or a 20GB archive.
- **Zero Server Uploads:** 100% client-side execution. Your emails never leave your device.
- **100% Offline Capability:** Operates completely offline without an active internet connection (verified in Airplane Mode).
- **Tracking Pixel Protection:** HTML emails render inside a sandboxed `<iframe>` with a strict Content Security Policy (`default-src 'none'; img-src data: blob:;`) blocking tracking beacons and external spy pixels by default.
- **Dual-Engine PDF Export:** Export individual messages as visual archival PDFs (preserving email styling, tables, and brand logos) or clean vector PDFs.
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

All benchmarks measured live inside Google Chrome on a physical mobile device:

| Archive Type | File Size | Emails Indexed | Ingestion Time | Throughput |
| :--- | :--- | :--- | :--- | :--- |
| **Real Google Takeout** | 23.8 MB | 571 emails | 0.88 s | 27.0 MB/s |
| **Synthetic Stress Archive** | 500.0 MB | 3,778 emails | 11.80 s | 42.4 MB/s |
| **Synthetic Scaling Archive** | 2.00 GB | 16,134 emails | 44.36 s | 46.2 MB/s |
| **Airplane Mode (100% Offline)** | 2.00 GB | 16,134 emails | 44.36 s | 46.2 MB/s |

---

## Privacy & Security Guarantee

1. **Zero Data Transmission:** No email subject, body, header, contact, or attachment is ever sent across the network.
2. **Zero Third-Party Trackers:** No analytics beacons, tracking cookies, or behavioral ad scripts run on private email reading views.
3. **Session Ephemeral:** Closing the browser tab clears all indexed data from system memory immediately.

---

## License

MIT © [aj00100](https://github.com/aj00100)

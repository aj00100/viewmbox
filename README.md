# ViewMBOX

<div align="center">

> **100% In-Browser Streaming MBOX & Google Takeout Viewer**  
> Open, search, and export multi-gigabyte `.mbox` archives locally in your browser. Zero software to install, zero file uploads, 100% offline-safe.

[![Live App](https://img.shields.io/badge/Live%20App-viewmbox.pages.dev-blue?style=for-the-badge&logo=cloudflarepages&logoColor=white)](https://viewmbox.pages.dev)
[![Architecture](https://img.shields.io/badge/Architecture-100%25%20Client--Side-brightgreen?style=for-the-badge)](https://viewmbox.pages.dev)
[![Offline](https://img.shields.io/badge/Offline%20Ready-Airplane%20Mode-orange?style=for-the-badge)](https://viewmbox.pages.dev)
[![License](https://img.shields.io/badge/License-MIT-purple?style=for-the-badge)](LICENSE)

<br/>

👉 **Launch Tool:** [**https://viewmbox.pages.dev**](https://viewmbox.pages.dev)

</div>

---

## ⚡ Architecture: The Zero-Upload Streaming Pipeline

Traditional online email viewers attempt to load the entire archive into contiguous memory at once, crashing the browser tab on files exceeding 50MB. **ViewMBOX** reads archives in 16MB windowed slices via a background Web Worker compiled as an in-memory Blob URL:

```mermaid
flowchart LR
    A["📁 Local Archive<br/>(Google Takeout 2GB+)"] -->|"File.slice() 16MB"| B["⚡ In-Memory Worker<br/>(Blob URL Engine)"]
    B -->|"Index Offsets"| C["🗂️ Virtualized Stream<br/>(Zero UI Freezes)"]
    B -->|"postal-mime in RAM"| D["✉️ Sandboxed Viewer<br/>(Strict CSP - No Trackers)"]
    D -->|"Isolated Print CSS"| E["📄 Archival PDF Export"]
    D -->|"URL.createObjectURL"| F["📎 Local Attachments"]

    style A fill:#f8fafc,stroke:#64748b,stroke-width:2px
    style B fill:#eff6ff,stroke:#3b82f6,stroke-width:2px
    style C fill:#f0fdf4,stroke:#22c55e,stroke-width:2px
    style D fill:#fefce8,stroke:#eab308,stroke-width:2px
    style E fill:#fdf2f8,stroke:#ec4899,stroke-width:2px
    style F fill:#f5f3ff,stroke:#8b5cf6,stroke-width:2px
```

---

## 🥊 Feature Comparison: Why ViewMBOX Wins

| Feature | Generic Web Viewers | Cloud Converters (SaaS) | Desktop Clients (Thunderbird) | ViewMBOX |
| :--- | :---: | :---: | :---: | :---: |
| **Max File Size** | ⚠️ ~50 MB (V8 Heap Crash) | ⚠️ ~100 MB Limit | Huge Disk Sync | **✅ Unlimited (Tested 2GB+)** |
| **Data Privacy** | ❌ May Upload | ❌ Sends Emails to Cloud | Local Storage | **✅ 100% In-Browser (Zero Uploads)** |
| **Offline Operation** | ❌ Fails Offline | ❌ Requires Internet | Requires App Install | **✅ 100% Airplane Mode Ready** |
| **Spy Pixel Protection** | ❌ None | ❌ None | Complex Settings | **✅ Sandboxed CSP Isolation** |
| **Setup Friction** | Zero | Account / Upload Queue | Bulky 200MB+ Install | **✅ Instant Drag-and-Drop** |
| **Cost** | Ad-Laden / Broken | Paid Subscription | Open Source | **✅ Free Forever** |

---

## 🚀 Key Capabilities

- **16MB Windowed Streaming:** Scans archives in 16MB slices in a background Web Worker. Maintains a flat ~20MB RAM footprint whether parsing a 50MB file or a 20GB archive.
- **Zero Server Uploads:** 100% client-side execution. Your emails, attachments, and headers never leave your device.
- **100% Offline Capability:** Operates completely offline without an active internet connection (verified in Airplane Mode).
- **Tracking Pixel Protection:** HTML emails render inside a sandboxed `<iframe>` with a strict Content Security Policy (`default-src 'none'; img-src data: blob:;`) blocking tracking beacons and external spy pixels by default.
- **Dual-Engine PDF Export:** Export individual messages as visual archival PDFs (preserving email styling, tables, and brand logos) or clean vector PDFs.
- **Attachment Extraction:** Extract images, PDFs, spreadsheets, and ZIP archives directly to your Downloads folder with one click.

---

## 📁 Supported Formats & Email Clients

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        SUPPORTED FORMATS                               │
├────────────────────────────┬───────────────────────────────────────────┤
│ Google Takeout (Gmail)     │ Takeout/Mail/All mail.mbox                │
│ Mozilla Thunderbird        │ Profile/Mail/Local Folders/*.default      │
│ Apple Mail                 │ Mailbox Exports (.mbox packages)          │
│ Legacy Mailboxes           │ Eudora, Opera Mail, Pine, Mutt            │
│ MIME Standards             │ RFC 4155, RFC 822, RFC 2822, RFC 5322     │
└────────────────────────────┴───────────────────────────────────────────┘
```

---

## 📊 Verified Benchmarks (Physical Android Mobile Device)

All benchmarks measured live inside Google Chrome on a physical mobile device:

| Archive Type | File Size | Emails Indexed | Ingestion Time | Throughput | Result |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **Real Google Takeout** | 23.8 MB | 571 emails | 0.88 s | 27.0 MB/s | **Verified ✅** |
| **Synthetic Stress Archive** | 500.0 MB | 3,778 emails | 11.80 s | 42.4 MB/s | **Verified ✅** |
| **Synthetic Scaling Archive** | 2.00 GB | 16,134 emails | 44.36 s | 46.2 MB/s | **Verified ✅** |
| **Airplane Mode (100% Offline)** | **2.00 GB** | **16,134 emails** | **44.36 s** | **46.2 MB/s** | **Verified ✅** |

---

## 🔒 Privacy & Security Guarantee

1. **Zero Data Transmission:** No email subject, body, header, contact, or attachment is ever sent across the network.
2. **Zero Third-Party Trackers:** No analytics beacons, tracking cookies, or behavioral ad scripts run on private email reading views.
3. **Session Ephemeral:** Closing the browser tab clears all indexed data from system memory immediately.

---

## 📄 License

MIT © [aj00100](https://github.com/aj00100)

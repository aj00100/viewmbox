# Master Execution & Publishing TODO
**Created:** November 20, 2026  
**Rule #1 (Research Freeze):** Do not run new Ahrefs/Bing keyword pulls, audit new niches, or buy any other domains until Phases 1–4 below are live and collecting real Search Console data.

---

## Phase 1: Launch viewmbox.com (English MVP)
**Target Date:** Today — Friday, November 20, 2026

### 1. Domain & DNS Setup
- [ ] Complete checkout for `viewmbox.com` on Hostinger (₹692 via UPI; skip all upsells — no Domain Shield, no paid email, no extra TLDs).
- [ ] Turn off auto-renew in Hostinger immediately after purchase.
- [ ] Add `viewmbox.com` to Cloudflare Dashboard and update nameservers in Hostinger.
- [ ] Enable Cloudflare Email Routing (free) to forward `hello@viewmbox.com` → your Gmail.

### 2. Production Deployment
- [ ] Deploy `/data/data/com.termux/files/home/viewmbox/dist/` to Cloudflare Pages (`npx wrangler pages deploy dist --project-name=viewmbox` or connect GitHub main branch).
- [ ] Attach custom domain `viewmbox.com` and configure `www.viewmbox.com` → `https://viewmbox.com` 301 redirect.

### 3. Live Adversarial Smoke Tests (Before Sharing)
- [ ] **Offline Proof Test:** Load `https://viewmbox.com`, open Chrome DevTools → Network → set to Offline, drop a test `.mbox` file, and confirm indexing + reading work with 0 network requests.
- [ ] **Tracker Blocking Test:** Open an HTML email with remote images and verify 0 external image requests fire until "Load Remote Images" is clicked.
- [ ] **Print / PDF Test:** Click Print / PDF and verify Chrome opens the print dialog cleanly (`sandbox="allow-modals"`).
- [ ] **ZIP Sniffer Test:** Drop a `.zip` file and confirm the amber Google Takeout extraction modal appears.

### 4. Day-0 Indexing
- [ ] Verify `viewmbox.com` in Google Search Console and submit `https://viewmbox.com/sitemap-index.xml`.
- [ ] Verify `viewmbox.com` in Bing Webmaster Tools and submit `https://viewmbox.com/sitemap-index.xml`.
- [ ] Fire a Bing IndexNow ping for all 7 initial English URLs.

---

## Phase 2: Spanish i18n (/es/) & Organic Distribution
**Target Dates:** Saturday–Sunday, November 21–22, 2026

### 1. Publish Spanish Subfolder on viewmbox.com
- [ ] Refactor `MboxApp.astro` to accept a `lang` prop (`"en"` | `"es"`) so all dropzone prompts, buttons, progress messages, and ZIP warnings render in native Spanish.
- [ ] Create `src/pages/es/index.astro` (`<html lang="es">`) targeting `visor mbox online` / `abrir archivo mbox online`.
- [ ] Add bidirectional `hreflang` tags (`en`, `es`, `x-default`) and a clean language switcher in `BaseLayout.astro`.
- [ ] Run `npm run build`, redeploy to Cloudflare Pages, and ping Bing IndexNow + GSC URL Inspection for `https://viewmbox.com/es/`.
- [ ] **Guardrail:** Stop at English + Spanish for now—do not add `de`/`fr`/`it`/`pt`/`ja` until GSC shows traction.

### 2. Initial Traffic & Organic Mentions ($0 Cost)
- [ ] **Hacker News (Show HN):** Submit Title + URL only (`https://viewmbox.com` — no body text in the submission box), then immediately post your engineering write-up (`File.slice()` 16MB streaming, 64-byte overlap, offline worker, CSP iframe) as the first comment.
- [ ] **AlternativeTo.net:** Submit `viewmbox.com` as a free, client-side alternative to Mozilla Thunderbird, GoldFynch MBOX Viewer, and SysTools MBOX Viewer.
- [ ] **Reddit (r/sysadmin, r/thunderbird):** Reply helpfully (non-spammy) to 2–3 active threads where users are stuck opening multi-GB Google Takeout `.mbox` archives.

---

## Phase 3: Contextual Portfolio Link (Day-30 Milestone)
**Target Date:** Friday, November 27, 2026 (Day 30 of `firmarpdfcertificado.com`, launched Oct 27)

- [ ] On `firmarpdfcertificado.com`, publish or update a Spanish guide on archiving official AEAT / Seguridad Social notifications and email backups.
- [ ] Insert 1 natural, in-content dofollow link with anchor text `visor MBOX online` pointing to `https://viewmbox.com/es/`.
- [ ] Do not add footer links or cross-language links from `firmarpdfcertificado.com`.

---

## Phase 4: Post-Code-Freeze Rollout on pdfandimg.com
**Target Window:** Immediately after `pdfandimg.com` code freeze lifts (₹0 domain cost, existing DR & active AdSense)

### Engine #6: Italy .p7m Unwrapper (Days 1–3 Post-Freeze)
- [ ] Scaffold `src/pages/it/aprire-file-p7m.astro` using an Italian-only layout (`<html lang="it">`, `hreflang="it"`, self-referencing canonical — no English exam-resizer header links).
- [ ] Wire in the already-verified `@peculiar/asn1-cms` engine (`client:load` eager bundle so offline mode works with Wi-Fi off).
- [ ] Confirm production features are active: recursive `.pdf.p7m.p7m` unwrapping, DOMParser FatturaPA HTML renderer (zero XSLTProcessor), DatiRiepilogo total fallback, Base64 `<Allegati>` PDF download, encoding sniffing (ISO-8859-1/UTF-8), and AgID non-validation disclaimer.
- [ ] Deploy to Cloudflare Pages, verify offline mode, submit via GSC URL Inspection, and fire Bing IndexNow.

### Engine #7: Brazil NF-e XML to DANFE PDF (Days 4–7 Post-Freeze)
- [ ] Scaffold `src/pages/pt/converter-xml-em-pdf.astro` using a Portuguese-only layout (`<html lang="pt-BR">`, `hreflang="pt-BR"`).
- [ ] Build v1 MVP: DOMParser XML extraction + JsBarcode Code-128C barcode for the 44-digit chNFe + clean printable A4 DANFE layout. (Skip SheetJS multi-tab Excel export for v1 to ship faster.)
- [ ] Deploy to Cloudflare Pages, submit via GSC URL Inspection, and fire Bing IndexNow.

---

## Phase 5: Measure & Iterate (No New Builds)
**Target Window:** 14–30 Days After Live Deployments

- [ ] Review Bing Webmaster Tools (expect first desktop impressions/clicks in 2–3 weeks) and Google Search Console across:
  - `viewmbox.com/` and `viewmbox.com/es/`
  - `pdfandimg.com/it/aprire-file-p7m/`
  - `pdfandimg.com/pt/converter-xml-em-pdf/`
- [ ] Apply for Google AdSense on `viewmbox.com` only after all 7+ English/Spanish pages are indexed and showing initial organic impressions.
- [ ] Use real GSC query data to decide the next move (either expanding `viewmbox.com` to `/de/` & `/fr/`, or shipping Engine #8 on `pdfandimg.com`).

---

## Permanently Killed Ideas (Do Not Revisit)
- ❌ **France Cerfa 15776\*02:** Official free gov simulator ranks #1 + Simplimmat app cannibalization + DR 64–91 wall + .fr AFNIC restriction.
- ❌ **Brazil MP4-to-MP3 / WhatsApp Audio:** ffmpeg.wasm OOM crashes on Android + COOP/COEP headers break Google AdSense.
- ❌ **Standalone .it / .fr / .com.br Domains:** Strict EU/CPF residency nexus rules.
- ❌ **Standalone Italy .p7m .com EMD:** Already sniped (`aprirefilep7m.com` & `aprirep7m.com`); rerouted to `pdfandimg.com/it/`.

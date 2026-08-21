# Creative Studio — production web (V4 shell) vs native iOS parity audit

Date: 2026-08-21 · Branch: `claude/creative-studio-ios-audit-132288`

Method: authenticated read of production `https://alma-erp-six.vercel.app/agent/creative-studio`
(confirmed serving the V3/V4 shell: Home · Projects · Assets & Gallery · Finishing · Review ·
Image Lab · Video & Reel · Avatars & Models · Voice · Audio & Music · Campaign Packs ·
Operations · Long-form editor + Creative Agent), full source read of
`src/agent/components/creative-studio-v3/*` + the legacy desks it embeds, and full source read of
the native iOS Creative Studio (`ios/App/App/CreativeStudio*.swift`, `CS*.swift`).

## 1. Bugs found in the shipped iOS build (fixed in this batch)

| # | Where | Problem | Fix |
| --- | --- | --- | --- |
| B1 | Gallery detail → "এই ছবি থেকে রিল 6s/16s/24s" | `reelFromImage` POSTs `/run` **without `intent`**. Server (`run/route.ts:203`) rejects with `run_estimate_required` → the three buttons silently fail in production. | Routed through the same signed estimate → owner confirmation gate as every other paid run; the estimate alert now lives on the detail sheet. |
| B2 | Create → Auto | `defaultModel` read `vm.models.first`, which includes the bundled sample models (`sm-*`) when the owner has no saved model. Auto then submitted `modelId: "sm-0"`. | Auto uses `realModels` only; empty state is shown instead. |
| B3 | Home filter chips | `সব / ছবি / ভিডিও / ফ্যামিলি / লাইফস্টাইল` were rendered but never filtered anything. | Chips now filter the recent strip + trending grid. |
| B4 | Mask repair presets | iOS sent preset ids `repair / remove / garment_detail`; the server contract (`mask-contract.ts`) only knows `replace_background / remove_object / repair_hand / contact_shadow / extend_canvas / custom`, so the preset template was silently dropped. | Native presets now use the exact contract ids + Bangla labels. |

## 2. Feature gaps (web has, iOS lacked) — implemented natively in this batch

### Image Lab / Create
- **Generate** mode (text → image, Grok Imagine / guided model) was missing from the mode rail.
- **Engine truth**: per-run engine picker mirrors `STUDIO_ENGINES` × `ADVANCED_ENGINE_CAPABILITIES`
  (FASHN direct, Guided image, Fal FASHN v1.6, IDM-VTON, FLUX Fill→Mask repair, Grok Imagine) with
  Live / Unavailable / Killed state from `config.engines`, filtered by the selected mode.
- **Resolution/aspect truth**: aspect + 1K/2K/4K options are now constrained by the engine's
  resolution contract (no more 4K promise on engines that cannot deliver it).
- **Product sources**: Paste (clipboard), **project ERP product** (the active project's catalog
  image, no upload), Upload. **Source slot** can now pick a ready Gallery image instead of upload
  only ("Continue from a recent image").
- Estimate confirmation shows engine, exact model, paid-attempt limit, receipt expiry (was ৳/$ only).
- Reel durations include the 16 s / 24 s Veo chains.

### Video Lab
- **Generated reel (Veo) composer**: start frame from a ready Gallery image or a saved avatar,
  motion prompt, vibe, 6/16/24 s, 9:16 / 16:9, signed estimate → confirmation. iOS only had the
  owned-footage recipe lane before.

### Gallery
- Categories **Audio / Avatar / Voice** added next to image/video + lifecycle filters.
- Sort by **name / cost** (client side, same as web), **Load more** (server cursor pagination).
- Detail sheet: **previous / next** navigation, metadata facts (verified original pixels, requested
  aspect, cost, publishable, created, reference receipt), **"এই ছবি থেকে নতুন তৈরি"** hand-off into
  Create with the source pre-selected, **Download original** through the scoped
  `/gallery/download` route when lineage fields are present.

### Finishing
- Brand layout gained **price** and **product name** fields (server accepted them; iOS never sent them).
- Mask repair: exact 6 presets, **erase** brush, **invert**, **feather** (none/soft/wide, applied
  client-side like the web), brush size, undo, clear.

### Audio
- **Dubbing** (bn/en/hi/ar · 30/60/120 s) and **Voice changer → active owner voice** (15/30/60 s)
  cards, both through the estimate → confirm gate.

### Home / shell
- **Search** (projects · assets · models), **project switcher** (brand + writable project — the
  same production scope used by Create/Gallery/paid confirmations), **Studio pulse** (worker state,
  needs-review count, live engines), **recent projects**, and quick-create entry cards for
  Image / Video / Avatar / Voice / Audio / Campaign / Long-form / Projects / Creative Agent
  (the V4 desks were only reachable through Library → "V4 Production Workspace").

### Projects / Long-form / Campaign
- **Project asset library** (folder + tag filters, folder/tag edit, version history & lineage,
  import from Legacy) — web `ProjectLibraryView`, absent natively.
- **Canvas preset** when creating a versioned composition (4:5 / 1:1 / 9:16 / 16:9 / custom) — iOS
  hard-coded 1080×1350.
- Campaign Pack **stage retry** for failed stages.
- Composition editor: **playhead + play/scrub**, proportional **timeline lanes**, **split at
  playhead**, media/source browser with search. The Creative Agent panel is reached from Home →
  Long-form → versioned canvas (same path as the web "Ask Creative Agent" → editor Agent tab).

## 3. Already at parity (no change)
Auto/Advanced estimate-confirm gate · family presets + role checklist · saved models (default /
delete / add / AI brand model) · owned-footage recipes + music library · Timeline Lite + transcript ·
motion templates · voice clone (consent) + version activate/revoke/delete · review transitions +
comments + exact pin + ৳0 render/export + rollout flags + job cancel/retry · provider kill switches ·
retention policy · performance · team roles · recipe manager · Drive connect · brand logo · settings.

## 4. Intentionally not ported
- Web-only keyboard shortcuts, responsive focus modes, CSS lightbox focus trap.
- Operations "HARD OFF" copy cards (iOS shows the same truth as safety pills in Lifecycle Control).
- Legacy studio toggle ("আগের ভার্সন") — system-owner web escape hatch only.

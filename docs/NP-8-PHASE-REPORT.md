# NP-8 — Filters, exports, stale escapes, product polish (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped

- **OP-06 Analytics custom range:** Custom chip + native start/end fields (YYYY-MM-DD validated) driving the SAME `/api/analytics` query params as the web Custom picker.
- **FN-04 XLSX resolution:** verified in source — the web XLSX exports (expenses + payroll) are `json_to_sheet` over the **identical columns** their CSV exports carry (src/lib/export-expenses.ts, export-payroll-wallet.ts). Formal contract decision: native CSV (Excel-compatible) IS the export; no native XLSX needed, no misleading copy remains.
- **OP-09 Orders stale copy:** "full drawer lives on the web" comment/copy removed — the remaining escape is documented as an optional web mirror/login fallback; every order workflow is native.
- **openWeb audit (exit gate):** every remaining internal `openWeb(` site (151 total, per-file counts pinned in `openWebAllowlist`) is a login fallback or an owner-visible optional web mirror on a fully-native screen — recorded as **EX-08** in the contract. Any NEW site fails the checker. Screens that lost their last escape this program: PortalStaffOffice (0 sites), plus 12 files with reduced counts across NP-2..NP-7.
- Accessibility labels added on new controls through NP-1..8 (tabs, chips, screenshot viewer, custom-range fields); every polling loop added in this program is lifecycle-gated (scenePhase + SwiftUI task cancellation) — no free-running timers were introduced.

## The big number

**Feature parity checker `--strict` (the NP-9 release gate) now PASSES: 0 open actions.**
All 104 contract actions across 43 surfaces are native or approved public/system handoffs.

## Verification

- Route checker → OK (70/66; temporary-web = creative-studio-demo only, whose web-page deletion rides the merge by owner constraint).
- Feature checker → OK + `--strict` → **exit 0**.
- Simulator build → see commit (green before push).

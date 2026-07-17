# NP-3 — Monitor Overview, Staff, Feed, System completion (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped

**Overview (web MonitorKPIStrip/AlertPanel/QuickActions parity):**
- 6-KPI tap-through grid: Agent Duties done/total, Staff Active, Pending Ack, Approvals, AI Cost (brain-stats), Failures.
- Dismissible alert panel (content-keyed IDs — the web's "index-shift resurrection" fix carried over) from `warnings` + delivery failures + many-unacked, with dismiss-all.
- Quick actions: 🚀 Deploy Worker (3-retry, step summary + target/running-commit verification line), ⟳ Retrigger menu (failed duties first + full DUTY_TO_JOB list), 🔔 NTFY All, ⏳ pending badge, last-deploy time.

**Staff (web MonitorStaffHub parity):**
- Tap-to-expand staff rows: capability strengths/weaknesses (staff-capabilities), geo state + Maps link, per-staff productivity alerts, 5 Bangla quick-action chips that PREFILL the native chat composer (new `AlmaComposerPrefill` — the web's `/agent?draft=…` deep link natively; never auto-sends, agent+confirm-card flow preserved).
- 📡 Live Surveillance: geo-fence tracking toggle (PATCH geo-fence + reload), per-staff geo chips, productivity list, 🎛️ Staff Task Controls (GET/PATCH /api/assistant/staff-toggles with echo).

**Feed:**
- Pending Ack: per-row 🔔 Critical NTFY + Notify All (POST escalate, web response-actions toast strings).
- Pending Approvals (48h): approve/reject — `staff_auto_message` approve via dedicated staff-monitor route, everything else + all rejects via `/api/assistant/actions/{id}/{decision}`; 409/410 replay reads as success (web rule).
- Active reminders + to-dos cards; feed expand/paging (NP-1) retained.

**System ([StaffMonitorSystemSwiftUI.swift](../ios/App/App/StaffMonitorSystemSwiftUI.swift)):**
- Duty rows grouped by the web's 7 categories, status dots, per-duty enable toggles (PATCH duty-enabled, `salah_init` locked, critical-off warning), expand → detail + ⟳ retrigger.
- Salah timeline + full 5-waqt × ৩-সময় time-config editor (GET/POST salah-times, server echo).
- Voice settings: the native app's real switches (voice streaming + wake word UserDefaults) — the web's on-device-STT flag is webview-scoped and stays there (noted in-card).
- Trust engine rules + tier menu (PATCH), Brain stats + prompt-cache line (costs/summary), Health scan (60s auto + Scan Now, retry-once) with auto-fix eligibility parity + 🤖 Fix This, Auto-Fix pipeline approve/reject, Background services chips, Deploy card, app build badge (version/build/ALMAGitCommit).
- Historical dates: all mutating/live-only cards gated on `isLive` (read-only mode).

Toast system (web top-banner parity, 4.5s auto-clear) + ops store on the screen's single coordinator; health 60s + staff 10s loops scenePhase-gated.

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED**
- Feature checker → OK: open actions 59 → **53** (AG-07 all native); openWeb snapshot 3→2 (System-tab temporary escape removed — checker caught the drop, snapshot refreshed).
- Route checker → OK (70/66).
- Exit-gate items batched to NP-9 sim session: screenshot comparison + action traces; network-failure-per-section behavior (each section already fails independently by design).

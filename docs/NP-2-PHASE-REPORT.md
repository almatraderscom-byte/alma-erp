# NP-2 — Monitor owner controls, models, heartbeat, SLO, Live Watch (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a`

## What shipped ([StaffMonitorAgentsSwiftUI.swift](../ios/App/App/StaffMonitorAgentsSwiftUI.swift))

1. **Control Center full parity (AG-02):** master pause (Bangla confirm dialog), autonomy 3-mode segmented control (আগে জিজ্ঞেস/করে জানাও/স্বয়ংক্রিয়), 3 capability toggles (ওয়েব রিসার্চ/সোশ্যাল পোস্ট/ছবি-ভিডিও) — all via PATCH /api/assistant/controls with the web's exact partial payloads; UI shows the server echo, never optimistic state.
2. **Autonomy SLO (AG-03):** GET /api/assistant/controls?section=slo — zero-invariants grid (duplicates/unapproved/unknown/guard-coverage), breach list with auto-demote note, per-class rows (stage/samples/reliability/verified/undo/cost, "যথেষ্ট ডেটা নেই" honesty preserved), outbox footer.
3. **Model toggles (AG-04):** GET/PATCH /api/assistant/models — collapsible card, search (>6 models), provider-grouped rows, per-row spinner, enabledMap echo applied.
4. **Heartbeat (AG-05):** full 20-entry timeline (kind emoji + Bangla labels + head badge), enable/disable + 🧪 test-now (POST {action}; response feed replaces state; test summary alert), wakesToday/cap line.
5. **Live browser (AG-06):** devices line (🟢/⚪️ per device), emergency stop/resume with confirm, latest screenshot decoded from data-URL with pinch-zoom viewer + ShareLink PNG (share sheet Save Image path; NSPhotoLibraryAddUsageDescription already present), full step feed (Bangla action labels, target, status badge, error, HH:mm).
6. **Model-routing dial + daily activity (web MonitorAgentsPanel):** Opus enable, premium-model selector with $/1M pricing, daily-cap stepper + usage bar, confidence slider, ৳-threshold chips, dirty-state save/cancel via POST /api/assistant/model-routing ({config} echo), "🎥 আজ কে কী করেছে" agents+specialists rows.
7. **Polling (roadmap §4.9):** one screen-owned VM; 10s status-strip loop + tab-visible-only 2.5s watch / 30s panel cadence, scenePhase-gated, SwiftUI-cancelled. No per-card timers.

Main file: old read-only owner-panel block (450 lines) deleted; header comment updated; Agents tab renders the new module.

## Verification

- `xcodebuild … iPhone 17 Pro Max build` → **BUILD SUCCEEDED**
- Feature checker → OK, open actions 70 → **59** (AG-02..AG-06 native); openWeb snapshot drift (4→3 on StaffMonitorSwiftUI, escape removed) was caught by the checker and recorded — exactly its job.
- Route checker → OK (70/66).
- Live mutation cross-check (web vs iOS same control values) + stop/resume against a live session: batched to the NP-9 owner-approved sim session.

## Deliberate scope note

- Web control-center's embedded phase-57 "স্বয়ংক্রিয়তার সিঁড়ি" ladder (AutonomyControlCenter) is NOT in AG-02's contract actions (autonomy mode + capabilities only). The ladder's promote/pause controls remain web for now; if the owner wants it native it can ride NP-3's System work.

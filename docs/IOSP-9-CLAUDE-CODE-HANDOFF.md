# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-9 only

Copy into a fresh session. Authorizes **IOSP-9 only**. IOSP-0..8 complete (`docs/IOSP-{0..8}-*.md`).

---

You are taking over at **IOSP-9 — accessibility + visual consistency + final regression + owner checklist** (roadmap §9, the LAST phase).

## Required reading

1. `CLAUDE.md`; roadmap §9 in `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md`.
2. `docs/IOSP-8-PHASE-REPORT.md` (17 VMs are now `@MainActor`; WKProcessPool gone) and `docs/IOSP-7-EXCEPTION-LEDGER.md` (sanctioned web-remainders — do NOT "fix" them).
3. `docs/proofs/iosp0/` baseline vs `docs/proofs/iosp8/` for regression comparison points.

## IOSP-9 scope

- **Accessibility pass:** Dynamic Type on the native SwiftUI screens (largest sizes must not clip money figures), VoiceOver labels on icon-only buttons (tab bar, glass bar buttons, approval Approve/Reject, floating chat head), Reduce Motion honoured (IOSP-5 covered Agent — sweep the rest), contrast on the aurora/glass surfaces.
- **Visual consistency:** one pass over the native screens against the locked design tokens (AlmaSwiftTheme / ios27 tokens) — spacing, corner radii, header treatments; fix drift, do NOT redesign.
- **Final regression:** rerun the IOSP-0 baseline drive (5 root tabs + deep links + the IOSP-1 nav self-test route list) on the Pro Max sim; compare launch/perf signposts vs `docs/proofs/iosp0/perf-signposts.txt`; confirm the IOSP-4 crash-repro and IOSP-3 cache self-tests still pass.
- **Watch item from IOSP-8:** `/api/assistant/office/notifications` + `…/intercom` were slow (>20 s authed) on 2026-07-16 — recheck; if still slow it is a SERVER issue to report, not an iOS fix.
- **Owner checklist:** produce the final Bangla device-test checklist (one TestFlight build covering IOSP-1..9, per the batching rule) + the roadmap-complete summary with the owner-blocked Xcode-27 list carried forward.

## Safety and branch rules

- Live production ERP. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free pair — verify (expect **agent-phase-26** + `pre-agent-phase-26`).
- Never touch `/api/agent/*` or its auth; no money; no secrets; additive migrations only.
- Do not merge/deploy/TestFlight yourself. Sim `9E51818A-…` only; never `5F79315F-…`; print the UDID before every simctl/xcodebuild.
- iOS-only branches now SKIP Vercel preview builds (`scripts/vercel-skip-ios-only.sh`, on agent-phase-25) — keep phase changes inside `ios/` + `docs/` so the skip holds.

## Deliverables

Files changed; a11y findings fixed vs deferred; regression PASS/FAIL vs IOSP-0 baseline; owner Bangla checklist; final roadmap-complete report. Stop after IOSP-9 — the roadmap ends here.

---

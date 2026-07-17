# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-7 only

Copy into a fresh session. Authorizes **IOSP-7 only**. IOSP-0..6 complete (`docs/IOSP-{0..6}-*.md`).

---

You are taking over at **IOSP-7 — Remaining native parity and deep workflows**.

## Required reading (first)

1. `CLAUDE.md` (highest authority — money rules; browser-proof-before-done; never touch /api/agent/*).
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` §8 Phase IOSP-7, §12 safety.
3. `docs/IOSP-6-PHASE-REPORT.md` — **important context: core mutation parity is already done; IOSP-7's real remaining items are narrow** — plus `ios/route-contract.json` (the `notes`/`gapPhase` fields flag each residual).
4. Source per item: `InventorySwiftUI.swift`, `SupplierImportSwiftUI.swift`, `SettingsUsersSwiftUI.swift`, `SettingsSmsSwiftUI.swift`, `BusinessArchive*`, `TradingAccountsSwiftUI.swift`, `Digital*`, `AgentCostsSwiftUI.swift`, `AttendanceSwiftUI.swift` (selfie capture), password-reset.

## Authorization

IOSP-7 only. End with a phase report + IOSP-8 handoff.

## IOSP-7 scope (roadmap §8) — the genuinely-remaining items

Per the IOSP-6 audit, most parity is done. Close what actually remains, each verified:
- inventory bulk/image/collection work;
- supplier import execution;
- users/roles/password/permissions deep flows;
- SMS send-test and other settings mutations;
- business archive/restore mutations;
- trading account create/edit/settlement/detail/exports;
- Digital/CDIT client/project/invoice secondary actions;
- agent cost/budget/log/CSV-export workflows;
- **Live Watch** (`/agent/live-watch`) and **`/portal/wallet`** — the IOSP-1 temporary-web exceptions: decide native-or-retire, with owner sign-off;
- secure password-reset completion (native shell + secure token handling);
- **native selfie camera capture** (Attendance) — device-camera flow, its own careful sub-task.

System-handoff exception: OAuth uses the system auth session/browser boundary, not an embedded ERP WKWebView.

## Exit criteria

Route contract reports zero unapproved internal web transitions; every approved exception has owner, reason, telemetry, expiry/review date. Update `ios/route-contract.json` + keep `scripts/iosp0-route-contract-check.mjs` green.

## Verification

Native sheets: DEBUG harness + signposts + timed screenshots on sim `9E51818A-…` (re-enroll Face ID after reboot). Financial/mutation flows: owner Chrome/device verification per `CLAUDE.md` (Vercel preview + owner-Chrome proof for any web/API change; owner types credentials). Camera capture: device-only — owner verification. **Never** touch the other session's iPhone 17 Pro `5F79315F-…`; print the UDID before every simctl/xcodebuild. **Do NOT hand-drive the sim UI.**

## Safety and branch rules

- Live production ERP, sensitive financial code. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free pair — verify (expect **agent-phase-24** + `pre-agent-phase-24`).
- Never touch `/api/agent/*` or its auth; whole-taka + salary/wallet semantics load-bearing; no secrets; additive migrations only.
- Do not merge/deploy/TestFlight. Final TestFlight is owner-triggered CI after IOSP-9.

## Deliverables

Files changed; per-item native-vs-web status + exception ledger (owner/reason/telemetry/expiry); proof; PASS/FAIL; branch/commit; risks; IOSP-8-only handoff. Scope realistically — verify each item; don't assume. Stop after IOSP-7.

---

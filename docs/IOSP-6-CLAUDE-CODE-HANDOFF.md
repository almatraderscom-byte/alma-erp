# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-6 only

Copy into a fresh session. Authorizes **IOSP-6 only**. IOSP-0..5 complete (`docs/IOSP-{0..5}-*.md`).

---

You are taking over at **IOSP-6 — Core ERP native action parity**.

## Required reading (first)

1. `CLAUDE.md` (highest authority — esp. money: whole-taka via `roundMoney`; salary_payment is a debit; do not refactor financial code unprompted).
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` §8 Phase IOSP-6, §4.3 (feature-level forced-web gaps), §7 gates, §12 safety.
3. `docs/IOSP-0-BASELINE-REPORT.md` §6 + `ios/route-contract.json` (the "notes" fields flag each screen's remaining web escape hatches) + `docs/IOSP-1-PHASE-REPORT.md` (nav coordinator — the `openWeb` escape-hatch pattern).
4. Source: `OrdersSwiftUI.swift`, `ApprovalsSwiftUI.swift`, `Finance*/Payroll/Expenses/OfficeFund` screens, `PortalSwiftUI.swift`, `AttendanceSwiftUI.swift`, `EmployeesSwiftUI.swift`; shared API client `AlmaAPI.swift` (+ IOSP-3 `getCached`).

## Authorization

IOSP-6 only. End with a phase report + IOSP-7 handoff.

## IOSP-6 goal and work (roadmap §8, priority order)

Replace the highest-value internal **web escape hatches** inside already-native screens with native sheets/screens, on the existing API contracts:

1. **Orders** — full order drawer + secondary workflows
2. **Approvals** — any web confirm/detail
3. **Finance / expenses / payroll / office-fund** — deeper mutation workflows
4. **Portal / payment accounts / wallet / task actions**
5. **Attendance** (selfie/camera flow) + **employee detail**

Rules: share existing API contracts + authorization (no duplicate business rules); **preserve whole-taka arithmetic via the project money helpers**; preserve salary/wallet debit semantics; add idempotency + self-verification where mutations require it; retain web only for explicitly approved public/system flows.

## Exit criteria

Priority workflows have zero unapproved WKWebView transitions; success/error/partial-failure states verified against real preview data; financial mutations include before/action/verified-after evidence; role/permission matrix passes; Vercel preview + Chrome proof completed for any API/web change.

## Verification (build success is NOT proof)

This phase mutates business data — verify against real preview data with before/action/verified-after evidence (the agent self-verification pattern). Any change to web/API code REQUIRES a Vercel preview + the mandatory owner-Chrome browser proof (`CLAUDE.md` hard rule) — if login is needed, the owner types credentials, never you. For native sheets, use the DEBUG harness + signposts + timed screenshots on sim `9E51818A-…` (re-enroll Face ID after reboot). **Never** touch the other session's iPhone 17 Pro `5F79315F-…`; print the UDID before every simctl/xcodebuild. **Do NOT hand-drive the sim UI** — owner runs the tap-level financial checklist (Bangla). Because this is financial, prefer owner verification for money mutations; Claude proves the native sheet renders + submits + the server result is verified.

## Safety and branch rules

- Live production ERP, sensitive financial code. Preserve unrelated dirty state/worktrees. Never `git add -A`.
- Branch/tag: next free pair — verify (expect **agent-phase-23** + `pre-agent-phase-23`).
- Never touch `/api/agent/*` or its auth. New agent API routes only under `/api/assistant/*`. Whole-taka money rules + salary/wallet debit semantics are LOAD-BEARING — do not refactor.
- No secrets; additive migrations only.
- Do not merge/deploy/TestFlight yourself. TestFlight is the final owner-triggered CI build after IOSP-9.

## Deliverables

Files changed; per-workflow native-vs-web status; before/action/verified-after for each financial mutation; role/permission results; Vercel+Chrome proof if web/API changed; PASS/FAIL; branch/commit; risks; IOSP-7-only handoff. Scope realistically — if the full priority list is too large for one safe pass, do Orders+Approvals thoroughly and hand the rest to IOSP-7 rather than rushing financial code.

---

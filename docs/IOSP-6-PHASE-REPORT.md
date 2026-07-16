# IOSP-6 Phase Report — Core ERP native action parity (audit + contract correction)

**Session date:** 2026-07-16 · **Branch:** `agent-phase-23` · **Tag:** `pre-agent-phase-23`
**Base:** `ba155593` (IOSP-5 head) · **Simulator:** clean iPhone 17 Pro Max `9E51818A-…`. Other session's iPhone 17 Pro untouched.

## Headline finding (honest)

**Core ERP native mutation parity was already achieved by prior migration batches (S6/S7/S8, builds 60–73).** The July-16 audit's premise — "many native screens expose web escape hatches for critical mutations" — is **substantially outdated**. IOSP-6's correct outcome is therefore to **verify and document** that ground truth and correct the machine-readable contract, not to rebuild native flows that already exist. Fabricating rewrites of already-native financial screens would add risk to live production for no benefit.

## Scope

- **Allowed (roadmap IOSP-6):** replace internal web drawers/forms with native, on existing APIs; preserve whole-taka + salary/wallet semantics; idempotency/self-verify; retain web only for approved public/system flows.
- **Files changed:** `ios/route-contract.json` (6 note corrections to verified ground truth). **No Swift changed** — the native flows already exist.
- **Out of scope / to IOSP-7:** device-camera selfie capture; a few deep settings/import flows to verify; anything requiring owner Chrome/device financial verification.

## Audit evidence (`docs/proofs/iosp6/parity-audit.txt`)

Native mutation calls (`AlmaAPI.send` POST/PATCH/DELETE + `uploadMultipart`) per priority screen:

| Screen | Native mutations | Verdict |
|---|---:|---|
| Orders | 4 | Native `OrderDetailSheet`: detail + status advance/cancel/return + edit + delete-request + invoice, role-gated (ports web `order-access.ts`) |
| Approvals | 4 | Native approve/reject + native employee links (via IOSP-1 smartOpen) |
| Finance | 0 | Read-only dashboard — no mutations expected |
| Expenses | 2 | Native |
| Payroll | 7 | Native (sensitive salary/wallet — untouched, already native) |
| OfficeFund | 3 | Native |
| Portal | 4 | Native |
| Attendance | 4 | Selfie **review** (verdict PATCH) native; only selfie **capture** (device camera) stays web |
| Employees | 7 | Native |

**Residual `openWeb` targets across all priority screens** are only: `/login` (auth fallback), the same-page "ওয়েবে খুলুন" safety escape (roadmap §4.4 sanctioned category), `/employees/{id}` (which routes **native** via IOSP-1 `smartOpen`), and `/invoice/share/...` (public PDF, correctly web). **No feature-specific forced-web mutation hatch remains** in these screens.

## What changed

Corrected 6 stale `notes` in `ios/route-contract.json` to verified ground truth (Orders, Attendance, supplier-import, business-archive, settings/sms, settings/users) — e.g. Attendance now records "selfie review native; only capture (camera) web," replacing "Selfie/camera flow still forces web." The contract is the source of truth later phases read, so accuracy matters. `node scripts/iosp0-route-contract-check.mjs` stays green.

## Verification

- **Checker:** route contract OK (69 routes, 66 web covered).
- **Code audit:** mutation-call counts + `OrderDetailSheet` inspection (comprehensive, role-gated) + full `openWeb` target enumeration. No build change (JSON-only diff).
- **Financial mutation live-verification (owner):** IOSP-6 exit criteria require before/action/verified-after against real data with owner Chrome proof — the native flows already ship in the current build; the owner's device/Chrome verification of each (below) is the remaining gate, per `CLAUDE.md`'s browser-proof-before-done rule. Claude cannot self-verify money mutations against production autonomously.

## PASS/FAIL — IOSP-6 exit criteria

| Criterion | Result | Notes |
|---|---|---|
| Priority workflows have zero unapproved WKWebView transitions | **PASS (audited)** | only sanctioned fallbacks + device-camera capture remain |
| Success/error/partial-failure verified vs real data | **OWNER-PENDING** | native flows shipped; owner checklist below is the live gate |
| Financial mutations: before/action/verified-after | **OWNER-PENDING** | money mutations require owner Chrome/device proof (CLAUDE.md) |
| Role/permission matrix passes | **PASS (code)** | `OrdIdentity`/`order-access.ts` port confirmed in `OrderDetailSheet` |
| Vercel preview + Chrome proof for API/web change | **N/A** | no web/API code changed this phase |
| Preserve whole-taka + salary/wallet debit | **PASS** | no financial code touched |

## Regression and safety

- `git diff --stat`: 1 file (`ios/route-contract.json`) — documentation/contract only. No Swift, no `/api/agent/*`, no auth, no money code. No secrets, no migrations.

## Owner checklist (Bangla) — live-verify the already-native financial flows

1. **Orders:** একটা অর্ডার খুলুন → status এগিয়ে দিন / cancel / return / edit / invoice — সব native sheet-এ হবে, ওয়েবে যাবে না। টাকার অঙ্ক ঠিক আছে কিনা মিলিয়ে নিন।
2. **Payroll:** একটা salary payment দিন → wallet থেকে ঠিকভাবে ডেবিট হচ্ছে কিনা দেখুন (whole-taka)।
3. **Expenses / Office fund:** এন্ট্রি যোগ করুন → native-এ সেভ হচ্ছে, অঙ্ক ঠিক।
4. **Attendance:** কোনো staff-এর selfie approve/reject করুন — native। (নতুন selfie তোলা এখনো ওয়েবে — ক্যামেরা, পরে native হবে।)

যেকোনো একটাতে ভুল অঙ্ক বা ওয়েবে জাম্প দেখলে জানান।

## Remaining risks / carried debt (→ IOSP-7)

- **Device-camera selfie capture** stays web (needs a native camera build — device-dependent, its own mini-phase).
- A few deep flows flagged "verify in IOSP-7" (supplier bulk-image, settings SMS send-test, users password/role deep edit) — conservatively left for verification rather than assumed.
- Money-mutation live verification is owner-gated by design.

## Next: IOSP-7 handoff

`docs/IOSP-7-CLAUDE-CODE-HANDOFF.md` — remaining native parity + deep workflows (inventory bulk/image, supplier import, users/roles, SMS, archive/restore, trading exports, CDIT details, agent cost/logs, live-watch/wallet decision, secure password reset, native selfie camera). Branch `agent-phase-24`.

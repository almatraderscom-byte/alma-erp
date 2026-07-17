# NP-0 — Freeze truth + action-level parity contract (completion evidence)

**Date:** 2026-07-17 · **Branch:** `claude/ios-native-parity-roadmap-aab64a` (Vercel previews skipped — all changes under `ios/`, `docs/`, `scripts/ios*`)

## Baseline (frozen)

- Baseline SHA: `66548124` (merge of PR #435, latest `origin/main` at session start)
- iOS build in git: `CURRENT_PROJECT_VERSION = 76`
- iOS build installed on approved simulator (per 2026-07-17 deep audit): 75 — revalidate at NP-9 sim session
- Web production: `https://alma-erp-six.vercel.app` — `/api/health` ok 2026-07-17T08:43Z, environment=production, db ok, wallet_ledger ok
- API base: `https://alma-erp-six.vercel.app`

## Deliverables

1. **`ios/feature-parity-contract.json`** — action-level contract: 43 surfaces, 104 actions, 7 approved exceptions, openWeb snapshot (57 files / 166 call sites). Covers the full roadmap master ledger (AG-01..13, AU-01..02, AD-01..09, TR-01..05, FN-01..04, OP-01..09) + do-not-rebuild ledger (DN-01).
2. **`ios/feature-parity-contract.schema.json`** — schema.
3. **`scripts/ios-feature-parity-check.mjs`** — fails on: untracked gaps (non-native action without plannedPhase), openWeb call-site gains/drops vs snapshot, internal routes posing as exceptions, malformed contract. `--strict` = NP-9 release gate (fails while any open action remains).
4. **Stale Swift header comments corrected** (14 files, comment-only, verified against actual methods): KnownPeople, CreditUsage, SettingsSms, SettingsTelegram, TargetControl, TradingAccounts, TradingHr, TradingStaff, DigitalClients, DigitalProjects, DigitalInvoices, Portal, Expenses (+ DigitalProjects). Each now states its NATIVE WRITES with endpoints and what genuinely remains web (with ledger ID + phase).

## Verification

- `node scripts/iosp0-route-contract-check.mjs` → **OK** (69 fixtures / 66 routes; 5 temporary-web gaps = the known IOSP-7 ledger)
- `node scripts/ios-feature-parity-check.mjs` → **OK** — 75 open actions, ALL tracked by phase (NP-1: 5, NP-2: 11, NP-3: 6, NP-4: 9, NP-5: 16, NP-6: 15, NP-7: 10, NP-8: 3), none hidden
- `node scripts/ios-feature-parity-check.mjs --strict` → exit 1 (correct: release gate open until NP-8 done)
- `xcrun swiftc -parse` on all 14 edited files → clean (comment-only edits)
- No product behavior changes in this phase (exit-gate requirement) — diff is docs/comments/new checker files only.

## Deferred to NP-9 (owner instruction: sim session only after owner approval)

- Baseline web-Monitor + native-Monitor screenshots
- Revalidation of simulator-installed build number

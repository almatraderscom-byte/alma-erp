# Phase 67 — Durable internet/browser operator

Branch: `agent-phase-67` (stacked) · Tag: `pre-agent-phase-67`
Goal: make supported online work reliable without claiming the agent can fix the whole internet.

## Delivered + verified — the pre-execution TASK CONTRACT

The existing browser layer already had strong pieces: an honest blocker taxonomy
(`diagnostics.ts` — owner-fixable vs vendor/platform, never "fixed the outage"),
declared-before-action success criteria + independent end-state re-read
(`success-criteria.ts`), resumable checkpoints, and the security modules
(prompt-injection / secret-dlp / egress-policy). The missing piece was the
roadmap's unified **task contract declared before execution + per-step enforcement**.

Added to `browser/success-criteria.ts`:
- `BrowserTaskContract` — target domains, read/write scope, success criteria,
  prohibited actions, owner-handoff triggers. `validateContract()` requires all
  of it before any action.
- `checkStepAgainstContract()` — deterministic per-step gate: **cross-domain →
  block**, **task-prohibited action → block**, **write under a read scope →
  block**, and **password/MFA/OTP/CAPTCHA/account-recovery/permission/legal/
  payment/final-submit → owner handoff** (`ALWAYS_HANDOFF_ACTIONS`, plus any
  task-specific triggers).
- `domainOf` / `domainInScope` — subdomain-safe scope matching (blocks
  `evil-facebook.com` masquerading as `facebook.com`).

## Self-verification

- **8-case contract test**: scope helpers (subdomain-safe), contract validation,
  and per-step enforcement (in-scope allow, cross-domain block, prohibited
  block, read-scope write block, always-handoff for every credential/payment
  action, task-specific handoff).
- **Full agent suite 185 files / 2344 tests PASS**; `tsc` 0 errors; existing
  browser diagnostics + success-criteria tests intact.

## Honestly NOT done (worker/live-browser runtime — cannot be verified solo)

- The exit-gate **runtime evidence** — 20 controlled tasks across ≥5 surfaces at
  ≥95% verified completion, zero cross-domain/secret-exfil/unapproved-submit/
  false-success, kill/reconnect resume-from-checkpoint, vendor-outage →
  diagnosis-not-false-fix — all require the VPS browser runner + real sessions.
- Wiring `checkStepAgainstContract` into `worker/src/browser/runner.mjs` as the
  live per-step gate is a worker-session change (needs the runner to prove it).

## Definition-of-Done (honest)

| Item | Level |
|---|---|
| Pre-execution contract + per-step enforcement (deterministic core) | 1–3 ✅ self-verified |
| Runtime 20-task evidence + resume + outage-honesty | 0 (worker runtime) |

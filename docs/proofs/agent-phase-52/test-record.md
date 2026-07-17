# Phase 52 proof — universal policy + tool-guard kernel

Date: 2026-07-17 (Asia/Dhaka) · Branch: claude/agent-roadmap-phases-2a10b1

## What shipped

- `src/agent/lib/policy/action-policy.ts` — pure constitutional decision core (allow/stage/deny), Bangla reasons
- `src/agent/lib/policy/capability-token.ts` — HMAC-signed action envelopes: exact-payload hash binding, expiry, deterministic idempotency keys
- `src/agent/lib/policy/data-classification.ts` — per-tool data classes + secret-leak tripwires
- `src/agent/lib/policy/tool-guard.ts` — runtime guard wrapping EVERY registered tool call (all 5 pools incl. CS) inside runRegisteredTool
- registry.ts: guard integrated after schema validation/turn gate/workflow guards, before every handler

## Enforcement matrix (production-safe by design)

HARD-BLOCKED now: untrusted-content (page/email/doc) instructions on any effect; stale/drifted approval payloads; same-turn duplicate effects; R4 without exact-payload approval envelope; irreversible/over-cap agent spends; out-of-scope accounts; revoked capabilities; explicit model-initiative writes with autonomy off.
SHADOW-LOGGED (Phase 57 promotes per class): point-of-risk staging for owner-direct R3 writes; bounded R2 proposals. No current owner/CS/cron flow changes behaviour.

## Exit gates

- 100% executable tools pass generated guard-coverage tests: **453 tests PASS** (287-tool totality sweep, 137 non-read injection blocks, stale-approval, duplicate, R4, registry integration)
- All 204 autonomy cases receive expected decision from the REAL policy core: **204/204 (100%)** — baseline was 46.1%
- No R3/R4 action executes from external-content instructions or stale approval: enforced + tested at guard AND executeTool level
- Full regression: **2002/2002 tests pass**, `tsc --noEmit` clean
- Chrome proof: DEFERRED (deploys disabled by owner instruction; final verification will show allowed read / staged write / denied injection / changed-payload re-approval live)

## Notable decisions

- Guard runs AFTER the existing turn read-only gate (no double-blocking of owner-service tools)
- Blocked calls do NOT claim idempotency keys (retry-after-fix works)
- Guard failure fail-closed for effects, fail-open for reads (constitution rule 8)
- R4 + valid exact-payload envelope proceeds ("owner confirms every exact action")

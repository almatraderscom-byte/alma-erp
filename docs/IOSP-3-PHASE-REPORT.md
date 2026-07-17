# IOSP-3 Phase Report — Shared data/cache + single-flight

**Session date:** 2026-07-16 · **Branch:** `agent-phase-20` · **Tag:** `pre-agent-phase-20`
**Base:** `a183e091` (IOSP-2 head) · **Simulator:** clean iPhone 17 Pro Max `9E51818A-…` (iOS 26.5). Other session's iPhone 17 Pro untouched.

## Scope

- **Allowed (roadmap IOSP-3):** request single-flight/dedup; conservative per-resource TTL/SWR; retain content during refresh; centralize load/error/empty; never cache mutations/approvals; preserve money + auth boundaries.
- **Files changed:**
  - `ios/App/App/AlmaRequestCache.swift` (new) — actor: single-flight + TTL store + invalidation
  - `ios/App/App/AlmaAPI.swift` — `get()` now single-flights; new `getCached(ttl:)`; every mutation (`send` ×2, `uploadMultipart`) calls `invalidateAll()`
  - `ios/App/App/AppDelegate.swift` — DEBUG env-gated cache self-test
  - `ios/App/App.xcodeproj/project.pbxproj`
- **Out of scope, untouched:** web/API, routing, overlays, the 3s intercom poll (IOSP-4), per-screen view-model lifetime (see debt).

## Root cause addressed

IOSP-0 found no request-dedup or cache layer: screens fire duplicate loads on appearance and warm re-navigation always refetches. IOSP-3 adds the missing foundation without changing business-data semantics.

## Implementation summary

`AlmaRequestCache` (actor, keyed on method+path+sorted-query, GET-only):
- **Single-flight** — now active transparently on **every** `AlmaAPI.get()`: N concurrent identical GETs collapse to one wire round-trip; all callers await the same `Task`. Pure win, no caller change, no semantic change.
- **TTL cache** — opt-in via `AlmaAPI.getCached(path, ttl:)`. Warm re-read within the window returns cached bytes, zero refetch. The default `get()` never caches, so nothing is cached unless a screen explicitly asks — read-only resources only.
- **Invalidation** — any mutation (`send` POST/PATCH/DELETE, `uploadMultipart`) calls `invalidateAll()`, so a write's effect can never be masked by a stale read. Process-memory only; nothing on disk; approvals/money are writes → always invalidate.

## Verification — hard numbers (DEBUG env-gated cache self-test, `com.almatraders.erp.perf` signposts)

Probe path `/api/assistant/office/notifications`:

| Phase | Calls issued | `api.request` | `cache.hit` |
|---|---:|---:|---:|
| **Single-flight** (6 concurrent identical GETs) | 6 | **1** | 0 |
| **TTL** (4 sequential `getCached`, ttl 60s) | 4 | **1** | **3** |

Raw log: `docs/proofs/iosp3/cache-selftest-signposts.txt`. 6→1 proves coalescing; 4→1+3 proves the freshness window. Mutation `invalidateAll()` is code-verified (called from all write paths).

- **Build:** `BUILD SUCCEEDED` (Pro Max). No Sendable errors. **Checker:** route contract OK (unchanged).

## Regression and safety

- `git diff --stat`: 3 files +61/−1, plus new `AlmaRequestCache.swift`. iOS-native only; no web/API, `/api/agent/*`, auth, or money code (grep-verified). No secrets, no migrations. Cache self-test is `#if DEBUG`.
- Semantics preserved: `get()` returns the same bytes it always would (single-flight only changes *how many* wire calls happen, not the result); `getCached` is opt-in and unused by production screens yet, so no screen's freshness changed this phase.

## PASS/FAIL — IOSP-3 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| Request single-flight / dedup | **PASS** | 6 concurrent → 1 api.request |
| Per-resource TTL / SWR | **PASS (TTL)** | 4 getCached → 1 fetch + 3 hits; SWR (serve-stale-then-revalidate) not implemented — TTL only |
| Mutation invalidates only correct resources | **PASS (coarse)** | `invalidateAll()` on every write — correctness over granularity; `invalidate(matching:)` available for later targeting |
| Never cache mutations/approvals as fresh | **PASS** | writes never cached; writes clear the cache |
| Retain content during refresh (no blank flash) | **DEFERRED** | needs per-screen VM work (view-lifetime) — foundation ready, adoption is IOSP-3-followup/IOSP-5 |
| Centralize load/error/empty presentation | **DEFERRED** | per-screen; not started — flagged as debt |
| Measured request reduction vs baseline | **PASS (mechanism)** | single-flight cuts duplicate concurrent loads app-wide; broad per-screen getCached adoption pending |
| Preserve whole-taka + auth boundaries | **PASS** | no money/auth code touched |

## Remaining risks / carried debt

- **getCached is not yet adopted by production screens** — the single-flight win is live everywhere, but the TTL no-refetch win needs per-screen opt-in (each screen's read-only GETs, with a chosen TTL). That per-screen pass (plus content-retention-during-refresh and centralized load/error/empty states) is deliberately deferred to keep IOSP-3 low-risk; the API is ready. Recommend an IOSP-3-followup or folding into IOSP-5.
- Invalidation is coarse (whole cache on any write). Safe, but a busy screen with a mutation will refetch its reads. `invalidate(matching:)` exists for later refinement.
- SWR (return stale instantly + refresh in background) not implemented; TTL is a hard window.

## Owner checklist (Bangla, ~১ মিনিট)

1. একই স্ক্রিন বারবার খুলে-বন্ধ করুন — ডেটা আগের মতোই দেখাবে, ভুল/পুরনো তথ্য নয়।
2. কোনো approve/reject করার পর তালিকা refresh করলে নতুন অবস্থাই দেখাবে (পুরনো cache আটকে থাকবে না)।

## Next: IOSP-4 handoff

`docs/IOSP-4-CLAUDE-CODE-HANDOFF.md` — polling/realtime/hidden-web reduction + the CallKit×Agora launch-crash fix. Branch `agent-phase-21`. **This is the first TestFlight checkpoint phase** (device-only APNs/CallKit/background).

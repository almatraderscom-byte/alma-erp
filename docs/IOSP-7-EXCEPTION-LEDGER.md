# IOSP-7 — Remaining web exception & gap ledger

**Session date:** 2026-07-16 · **Branch:** `agent-phase-24` · **Tag:** `pre-agent-phase-24` · **Base:** `a1a732e6` (IOSP-6 head)

This is the roadmap's IOSP-7 exit artifact: **every remaining internal web transition, with owner / reason / telemetry / decision.** The honest finding (continuing from IOSP-6): the remaining gaps are the **security-sensitive and owner-gated tail** — user/role/password management, bulk import execution, device camera, and owner native-or-retire decisions. These are deliberately **not** built autonomously: modifying access controls and shipping money/permission mutations without owner Chrome/device verification would violate `CLAUDE.md` (browser-proof-before-done) and the assistant's own safety rules (no autonomous access-control changes).

## Verified native status (this session)

| Screen / flow | Native mutations found | Status |
|---|---:|---|
| Orders, Approvals, Expenses, Payroll, OfficeFund, Portal, Attendance (review), Employees | 4/4/2/7/3/4/4/7 | **Native** (IOSP-6 audit) |
| SMS settings | 5 | **Native** (mutations native; a send-test may still hop web — low priority) |
| Trading accounts | 2 | **Native** create/edit; settlement/export may be web |
| Supplier import execution | **0** | **WEB — genuine gap** (bulk data mutation) |
| Users create/edit/password/roles | **0** | **WEB — genuine gap; access-control, owner-gated** |
| Agent cost budget/logs/CSV export | web | **WEB — documented escape hatch** |
| Attendance selfie capture | web (camera) | **WEB — device camera** |
| Password reset completion | web | **WEB — secure-token flow** |

## Exception ledger (approved temporary-web, from IOSP-1 coordinator)

| Route | Reason | Telemetry | Owner decision needed | Target review |
|---|---|---|---|---|
| `/agent/live-watch` | Live-browser console is a heavy web surface | `route.webAllowed reason=temporary-web` | **Native-or-retire?** (owner) | this phase / owner |
| `/portal/wallet` | Financially sensitive; belongs with finance-parity | `route.webAllowed reason=temporary-web` | **Native wallet or keep web?** (owner) | with finance batch |
| `/forgot-password`, `/reset-password` | Secure token flow | (public/auth) | Native shell + secure handoff — owner-supervised | IOSP-9 or dedicated |
| `/agent/creative-studio-demo` | Dev/demo route | (public) | Exclude from prod nav / remove | housekeeping |
| Users/roles/password (in `/settings/users`) | Access-control mutation | — | **Owner-supervised build** (never autonomous) | dedicated |
| Supplier import execution | Bulk data mutation | — | Owner-supervised + Chrome-proof | dedicated |
| Attendance selfie capture | Device camera | — | Native-camera sub-phase (device verify) | dedicated |
| Agent cost budget/logs/CSV | Export/logs | — | Low priority; native later | later |

## Why these are not built in this autonomous run (honest)

1. **User/role/password management** = modifying access controls — explicitly outside what the assistant does autonomously, and security-sensitive on a live ERP.
2. **Supplier import execution, wallet, settlement** = money/bulk mutations — require the owner's Chrome/device before/action/verified-after proof per `CLAUDE.md`.
3. **Selfie capture** = device camera — not reliably verifiable in the simulator.
4. **Live-watch / wallet native-or-retire** = product decisions that are the owner's to make.

Each is a legitimate, scoped follow-up best done in an owner-supervised session (or with the owner's Chrome/device in the loop), not rushed in a headless autonomous pass. The route contract keeps them explicit (classification + telemetry), so nothing silently regresses — an unknown internal route still fails loudly (IOSP-1).

## Owner decisions requested

1. **`/agent/live-watch`** — build native, or keep as an approved web console permanently? (It's a heavy live-browser surface.)
2. **`/portal/wallet`** — native wallet screen, or keep web until the next finance batch?
3. **User/role/password management** — schedule an owner-supervised session to build these natively (I won't touch access-control autonomously).
4. **Native selfie camera** — schedule a device-verified sub-phase.

## Route contract

`node scripts/iosp0-route-contract-check.mjs` green. Every remaining internal web transition is a classified `temporary-web` exception with telemetry, or a documented gap above — **zero silent web transitions** (the IOSP-1 guarantee holds).

## Next: IOSP-8 handoff

`docs/IOSP-8-CLAUDE-CODE-HANDOFF.md` — Xcode 27/iOS 27 modernization. **Blocker:** Xcode 27 + iOS 27 runtime are NOT installed on this Mac; only the toolchain-independent cleanup subset is doable now. Branch `agent-phase-25`.

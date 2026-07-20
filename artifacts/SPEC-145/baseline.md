# SPEC-145 baseline — Worker lease and crash recovery

## Discovery commands
- `ls src/agent/workflows` → G14 `lease.ts` (acquireLease/heartbeat/assertLeaseHeld/isExpired) and `reconcile.ts` (reconcile/CONFIRMED_DONE/NOT_DONE/RECONCILE_AGAIN/ESCALATE) EXIST. Reused, not reimplemented (INV-06).
- `ls src/worker/queues` → 141..144 present; a task becomes LEASED on dequeue but nothing reclaims it if the worker crashes.
- `grep -rn 'acquireLease|reconcile' src/agent/workflows/{lease,reconcile}.ts` → the G14 primitives to import.

## Current implementation
None in queues. G14 provides step leases + unknown-outcome reconciliation for the durable workflow runtime. This spec binds those primitives to QUEUE TASKS: a worker holds a time-bounded lease on a LEASED task; on crash the lease expires and recovery reclaims the task — but ONLY through reconciliation, never a blind requeue (avoids double side effects).

## Callers / downstream
Imports `@/agent/workflows/lease` + `@/agent/workflows/reconcile`. Operates on SPEC-141 `QueueState`. Consumed by 150 chaos.

## Direct provider/model/tool/DB calls
None. The reconcile PROBE is an adapter seam (I/O outside); this module decides over an injected `finding`. `nowMs`/ttl/finding injected (INV-01).

## Tenant / permission / audit propagation
Recovery is per-task; the task keeps its ExecutionIdentity. Lease holder identity (workerId) is checked before any state change.

## Likely bypass paths
- Blind requeue of a crashed side-effecting task → double effect. Mitigated: recovery ALWAYS routes through reconcile (fail-closed) — requeue only on effect_absent; escalate on indeterminate-exhausted.
- Reclaiming a still-LIVE lease → mitigated: recovery denies unless the lease is expired.

## Proposed migration boundary
Feature-flag ladder; additive. `off` = no recovery, `enforce` = lease+reconcile recovery.

## Files expected to change
`src/worker/queues/{worker-lease.ts,index.ts,__tests__/worker-lease.test.ts}` — additive.

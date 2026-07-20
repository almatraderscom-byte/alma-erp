# SPEC-011 Baseline — Single admission gateway
## Discovery
```
$ ls src/agent/control-plane 2>/dev/null   # absent — new zone
$ git show G01:src/agent/contracts          # prerequisite contracts present
```
No admission control plane existed. Requests entered via scattered routes with
no single validated door. G01 contracts (component, execution-identity, errors)
are available as the prerequisite.

## Owned-zone decision (tailoring)
Spec lists `src/agent/control-plane/admission` AND `src/app/api/agent`. The
latter is the FROZEN Hermes legacy API (CLAUDE.md rule #2). Decision: do not
touch it; new code lives in `src/agent/control-plane/admission`, exposed later
via `src/app/api/assistant/*`. Recorded in the zone README.

## Provider/model/db calls
None. Admission is deterministic (INV-01).

## Cost/latency
Zero model calls.

## Migration boundary
Additive. New zone; nothing in production imports it yet.

## Files expected to change
- `src/agent/control-plane/admission/gateway.ts` (+test)
- `src/agent/control-plane/admission/registry.ts`
- `src/agent/control-plane/admission/README.md`, `src/agent/control-plane/tsconfig.json`

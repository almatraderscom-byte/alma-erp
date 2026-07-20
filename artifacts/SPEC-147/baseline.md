# SPEC-147 baseline — Browser compact observation state

## Discovery commands
- `ls src/agent/browser-runtime` → SPEC-146 present (`contract.ts` defines a bounded `Observation`, but nothing PRODUCES a compact/redacted one from a raw page).
- `grep -rln 'redact|REDACT|compact|firewall|bounded' src/agent/tool-gateway` → G10 result-firewall redaction ideas exist (tool-gateway stages) — reused as design reference for INV-07.

## Current implementation
None in the owned zone. SPEC-146 assumes a well-formed, bounded `Observation`. This spec builds the transform that turns a RAW page snapshot (potentially huge, containing secrets/values) into the compact, size-capped, secret-redacted `Observation` the model is allowed to see (INV-07). Element VALUES are dropped entirely; labels are redacted + truncated; the element set is capped by interactivity priority; a hard serialized-byte ceiling fails closed.

## Callers / downstream
Feeds SPEC-146 `validateObservation`/`decideAction`. Consumed by 149 (step observations) + 150 chaos.

## Direct provider/model/tool/DB calls
None. Pure transform; `nowMs`/caps injected (INV-01).

## Tenant / permission / audit propagation
Compact observation keeps ExecutionIdentity; the full raw snapshot stays in evidence storage (not modeled here) — only the bounded view is emitted (INV-07).

## Likely bypass paths
- Secret exfiltration through element labels/values → mitigated: values dropped; labels redacted by deterministic patterns; hard byte cap.
- Model-view blowup (token cost / injection surface) → mitigated: element cap + label truncation + byte ceiling.

## Proposed migration boundary
Feature-flag ladder; additive.

## Files expected to change
`src/agent/browser-runtime/{observation-state.ts,index.ts,__tests__/observation-state.test.ts}` — additive.

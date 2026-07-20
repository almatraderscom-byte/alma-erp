# SPEC-146 baseline — Browser plan/perception/action separation

## Discovery commands
- `ls src/agent/browser-runtime` → **absent**. Greenfield owned zone.
- `grep -rln 'live-browser|browser' src/app/api/assistant` → an ERP live-browser POLL route exists (`live-browser/poll`) but that is ERP surface, NOT owned by G15 and NOT modified.
- `grep -rln 'plan|perception|action' src/agent/browser-runtime` → none.

## Current implementation
None in the owned zone. This spec creates the browser runtime's core discipline: three SEPARATE typed phases — PLAN (intended steps), PERCEPTION (bounded observation of the page), ACTION (a single validated act). An action may only target an element that actually appears in the current perception and must reference a plan step — no blind/ hallucinated actions.

## Callers / downstream
Net-new zone. Adapter seams (`Planner`/browser driver) live outside and are model/tool calls governed elsewhere. Consumed by 147 (compact observation), 148 (replan), 149 (hard-stops), 150 (chaos).

## Direct provider/model/tool/DB calls
None in the deterministic core. Planning (LLM) and page I/O (browser) are adapter seams with deterministic fakes in tests (INV-01).

## Tenant / permission / audit propagation
Goal/plan/observation/action all carry ExecutionIdentity (INV-02).

## Likely bypass paths
- Acting on an element not present in the perception (prompt-injection / hallucination) → mitigated: action target MUST resolve to an observation element, else fail-closed DENIED.
- Unbounded plans → mitigated: bounded step count.

## Proposed migration boundary
Feature-flag ladder; additive greenfield.

## Files expected to change
`src/agent/browser-runtime/{tsconfig.json,contract.ts,runtime.ts,index.ts,__tests__/runtime.test.ts}` — additive.

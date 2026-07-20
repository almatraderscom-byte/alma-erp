# SPEC-075 — Baseline (tool risk & side-effect classification)

Parent: SPEC-074 (`d977d073`). Owned zones: registry, manifests.

Today `capability-classification.ts` carries `risk` (low/medium/high) and `mode`
per tool, and `tool-contract.ts::resolveClassification` derives approval/proof
from mode. There is NO explicit side-effect taxonomy, NO gateway/cost-auth/
reconciliation policy hint, and NO consistency enforcement between mode and the
effects a tool actually has.

Discovery:
```
$ grep -n "risk:\|approval:\|proof:" src/agent/tools/tool-contract.ts
$ grep -c "risk:" src/agent/tools/capability-classification.ts   # label only
```

Migration boundary: a policy table mapping each SideEffectKind to
{ external, requiresGateway (INV-04), requiresCostAuth (INV-03),
requiresReconciliation (INV-06) }, an aggregate `classifyManifest`, and a
consistency checker enforced across the entire generated manifest set.

Files expected: `risk-classification.ts`, tests, `index.ts` update.

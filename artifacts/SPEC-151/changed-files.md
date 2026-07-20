# SPEC-151 Changed Files

```text
 src/agent/models/__tests__/_helpers.ts             |  91 +++++++
 src/agent/models/__tests__/contract.test.ts        |  34 +++
 src/agent/models/__tests__/fabric.test.ts          | 148 ++++++++++++
 src/agent/models/__tests__/tiers.test.ts           |  35 +++
 src/agent/models/contract.ts                       |  96 ++++++++
 src/agent/models/fabric.ts                         | 266 +++++++++++++++++++++
 src/agent/models/index.ts                          |  14 ++
 src/agent/models/ports.ts                          |  60 +++++
 src/agent/models/reason-codes.ts                   |  41 ++++
 src/agent/models/registry.ts                       |  69 ++++++
 src/agent/models/tier-handler.ts                   |  62 +++++
 src/agent/models/tiers.ts                          | 113 +++++++++
 src/agent/models/tsconfig.json                     |  11 +
 .../runtime/__tests__/fake-adapter.test.ts         |  66 +++++
 src/agent/providers/runtime/adapter.ts             |  78 ++++++
 src/agent/providers/runtime/fake-adapter.ts        |  94 ++++++++
 src/agent/providers/runtime/index.ts               |  13 +
 src/agent/providers/runtime/tsconfig.json          |   5 +
```

All within owned zones (`src/agent/models`, `src/agent/providers/runtime`)
plus `artifacts/SPEC-151`. Zero files touched outside owned zones.

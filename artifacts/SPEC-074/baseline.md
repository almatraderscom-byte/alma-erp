# SPEC-074 — Baseline (tool input/output schema registry)

Parent: SPEC-073 (`d2159ede`). Owned zones: registry, manifests.

Today input schemas live on each `AgentTool.input_schema` and are validated at
call time by `tool-contract.ts::validateToolInput` (Ajv). That validator FAILS
OPEN on a schema that won't compile, and there is NO central registry keyed by a
stable id, and NO bounded-output-view discipline (INV-07) at this layer.

Discovery:
```
$ grep -n "validateToolInput\|strictenSchema\|ajv.compile" src/agent/tools/tool-contract.ts
$ grep -c "input_schema" src/agent/tools/*.ts   # schemas scattered across handlers
```

Migration boundary: a decomposed IO registry keyed by `manifest.io.inputSchemaId`
that (a) resolves every manifest, (b) validates strictly and FAILS CLOSED on an
unknown id, (c) produces a bounded, secret-redacted output view. Re-implemented
locally so the new registry does not depend on the monolith's tool-contract.

Files expected: `io-schema.ts`, `io-schemas.generated.ts` (generated),
`scripts/build-io-schemas.ts`, tests, `index.ts` update.

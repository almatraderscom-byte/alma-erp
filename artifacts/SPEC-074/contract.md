# SPEC-074 — Contract  (io-schema.ts, contract v1.0.0)

## Registry
`hasSchema(id)`, `getSchema(id)`, `schemaIds()`, `schemaCount()` over
`IO_SCHEMAS` (generated: one JSON Schema per manifest inputSchemaId, 326).

## Strict validation (self-contained Ajv)
`strictenSchema(schema)` — root object → additionalProperties:false, required:[].
`validateInput(schemaId, input): { ok, error? }` — coerces in place; unknown
schema id → **fail-closed** hard error (INV-05); reports unknown fields, missing
required, enum violations.

## Bounded output view (INV-07)
`boundedOutputView(payload, maxBytes=8KiB): BoundedView{ view, truncated,
redactedKeys, originalBytes }` — redacts secret-looking keys
(api_key/secret/token/password/authorization/cookie/private_key), truncates over
budget and marks that the full payload belongs in evidence.

## Boundary
`validateToolIo(raw): ComponentResult<IoResultValue>` — identity-enforced;
kinds validateInput | hasSchema | boundedView | count; never throws.

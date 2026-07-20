# SPEC-072 — Contract

`manifest.schema.ts` (zod + TS), contract version `1.0.0`.

## Envelope: `ToolManifest`
```
name        snake_case tool id
domain      business domain
title       human title
summary     model-facing description
version     strict semver MAJOR.MINOR.PATCH        (SPEC-077 logic)
status      active | preview | deprecated | removed
capability  { mode: read|stage|write,
              risk: low|medium|high,
              sideEffects: SideEffectKind[] (>=1, closed set) }   (SPEC-075 logic)
io          { inputSchemaId, outputSchemaId? }     (SPEC-074 registry)
ownership   { team, zonePrefix }                   (SPEC-076 logic)
routing     { groups[], pools[] }
deprecation?{ since, replacedBy?, removeAfter?, reason? }  (SPEC-078 logic)
```

## Closed taxonomies
- MANIFEST_MODES = read | stage | write
- MANIFEST_RISKS = low | medium | high
- MANIFEST_STATUSES = active | preview | deprecated | removed
- SIDE_EFFECT_KINDS = none, db_read, db_write, external_message,
  external_api_write, money_movement, file_write, browser_action,
  model_invocation, schedule, push_notification

## Cross-field rules (superRefine)
- `sideEffects` non-empty; `none` cannot combine; no duplicates.
- status deprecated/removed ⇒ MUST carry `deprecation`; active/preview ⇒ MUST NOT.
- `deprecation.replacedBy` ≠ own name.

## API
- `toolManifestSchema`, `parseManifest`, `safeParseManifest`, `isDeprecated`
- sub-schemas exported for reuse: `capabilitySchema`, `ioSchema`,
  `ownershipSchema`, `routingSchema`, `deprecationSchema`
- `validateManifest(raw): ComponentResult<ToolManifest>` — G01 identity-enforced
  boundary; fail-closed `MALFORMED_INPUT`; never throws.

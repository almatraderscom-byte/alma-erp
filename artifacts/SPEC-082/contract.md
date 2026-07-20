# SPEC-082 — Contract (intent-map.ts, v1.0.0)
- `capabilitiesForIntent(key): Capability[]` / `capabilitiesForClass(cls): Capability[]`
  / `allIntentKeys(): string[]` — sorted, stable.
- `checkIntentMapping(c) / checkAllIntentMappings(set): IntentIssue[]` —
  NO_INTENT | NO_CLASS | UNKNOWN_CLASS | MUTATING_INTENT_WITHOUT_CLASS
  (a manage_/create_/launch_/update_/send_/delete_ intent implies a
  'command'|'task' admission class).
- Boundary `queryIntentMap(raw): ComponentResult` — byIntent|byClass|keys;
  identity-enforced; never throws.

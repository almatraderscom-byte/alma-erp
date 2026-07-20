# SPEC-147 contract — Browser compact observation state

## Public contract
- Types: `RawElement`, `RawSnapshot`, `CompactionCaps` {maxElements,maxLabelChars,maxBytes}, `CompactionReport`.
- Fns: `compactObservation` → { result: ComponentResult<Observation>, report }, `isSecretLabel`, `redactLabel`, `redactUrl`.
- Reason codes: OVERSIZE, MALFORMED. Const `REDACTED`='[REDACTED]'.

## Compaction pipeline (INV-07, reuses G10 firewall redaction idea)
1. drop every element value; 2. redact secret-shaped labels (password/token/bearer/JWT/email/long-token) → REDACTED; 3. truncate labels to maxLabelChars; 4. cap element set by interactivity priority (buttons/links/inputs first, stable); 5. strip URL query+fragment; 6. hard serialized-byte ceiling ⇒ fail-closed OVERSIZE.

## Invariants
INV-01 deterministic (caps/nowMs injected; same input ⇒ identical output). INV-07 bounded, redacted model view; full snapshot stays in evidence. INV-05 fail-closed. No boolean success; no throw.

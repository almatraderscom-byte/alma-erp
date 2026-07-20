# SPEC-105 Unresolved Risks
Critical unresolved risks: **0**.

Notes (non-blocking, resolved by later specs by design):
- No concrete policy layers yet — engine is fail-closed (denies everything) until SPEC-106..109 register permit/deny layers. This is intended: dormant + safe.
- Feature-mode wiring (off/shadow/warn/enforce/rollback) is an integration concern; the pure engine is authoritative-neutral.

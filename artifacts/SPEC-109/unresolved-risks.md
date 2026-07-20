# SPEC-109 Unresolved Risks
Critical unresolved risks: **0**.

Notes: applier operates on JSON-shaped data (object/array/string/number). Non-serializable payloads (functions, class instances) are out of scope — the bounded model view is always plain data by design (INV-07). Malformed obligations are surfaced, not ignored.

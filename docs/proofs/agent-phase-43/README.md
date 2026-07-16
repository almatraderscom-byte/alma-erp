# Phase 43 proof — deferred by owner instruction

Owner directed (2026-07-17): phases 41–48 build on one branch, no Vercel deploys during
the work; combined owner verification at the end before merge.

Chrome proof for this phase (test-code-only CAPI event traced through
ledger → Meta Test Events → reconciliation view) will be captured in that round —
`marketing_capi_test_event` requires an Events Manager test code by design, so nothing
can pollute production data.

Local verification completed: 26 unit tests — full-funnel taxonomy, deterministic
event-id dedup (browser+server same id; duplicate recordEvent does not double-count),
PII contract (sha256-only, raw identifiers rejected + absent from payload fixtures),
timestamp/whole-taka normalization, CAPI wire mapping, UTM convention build/validate/
lineage parse, observed/modelled/unknown profit labels, cross-source reconciliation
issues + confidence. Full typecheck clean.

# SPEC-127 — Architecture scan
`execution-adapter.ts` imports `@/agent/contracts`, relative. It calls ONLY
`deps.adapter.execute` — the sole provider/network seam. The gateway core has no
fetch/axios/provider import (scan clean); real network lives behind the injected
adapter, faked in tests (INV-01). No ERP→agent import. Ownership diff: only
tool-gateway + artifacts/SPEC-127. PASS.

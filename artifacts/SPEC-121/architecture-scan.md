# SPEC-121 — Architecture scan
`contract.ts`/`gateway.ts` import `@/agent/contracts`, `zod` only. No Date.now,
Math.random, fetch, prisma, ioredis (scan clean) — INV-01 deterministic. Provider/
network is confined to the ExecutionAdapter seam. No ERP→agent import. Ownership
diff: only tool-gateway + artifacts/SPEC-121. PASS.

# Phase 66 — Make Personal/Business OS reachable and real

Branch: `agent-phase-66` (stacked) · Tag: `pre-agent-phase-66`
Goal: activate the two internal OS adapters correctly, then establish the safe one-service-at-a-time pattern.

## Delivered + verified — reachability (GAP-06: OS tools had 0 references)

1. **Both tool families imported into the registry** — `PERSONAL_OS_TOOLS` + `BUSINESS_OS_TOOLS` are now in the `TOOLS` execution pool (`registry.ts`), so the head can actually call them (no more "sees it but Unknown tool").
2. **Grouped for discovery** — `personal_os_*` in the `personal` group, `business_os_*` in the `erp` group (`tool-groups.ts`), so `select-tools` surfaces them by intent.
3. **Classified** — added `capability-classification.ts` entries (`read('personal')`/`stage('personal')`/`read('erp')`/`stage('erp')`), keeping `unclassifiedTools()` empty and giving each a proper guard classification. Param descriptions filled in so the strict-contract manifest test passes.
4. **Adapter bootstrap (closes "registerServiceAdapter has no caller")** — new `integrations/bootstrap.ts`:
   - `bootstrapServiceAdapters()` registers `personal-records` + `erp-orders` exactly once (idempotent via the registry Map + a module flag).
   - **In production, in-memory stores are impossible**: `personal-records` uses the Prisma store; `erp-orders` is **refused** in production (only a memory store exists today — it waits for a Prisma orders store rather than shipping a silent fake).
   - `ensureServiceAdaptersBootstrapped()` is called lazily from each OS tool handler, so the adapter is registered on first use (serverless-safe).

## Safety

- The OS tools are **read + private-stage only** — no external effect (the adapter's write op is separate and rides the Phase 65 effect engine). Exposing them is safe even before any adapter connects: they refuse gracefully (`unknown service` / `service_not_ready`) when the named adapter is absent or ungranted.
- `assertOpAllowed` still gates every call on connection/readiness/least-privilege (unchanged).

## Self-verification

- **Golden routing test** proves: all 4 OS tools are in `TOOLS`; personal group exposes the personal tools; erp group exposes the business tools; bootstrap registers both adapters (dev/test) and is idempotent.
- **Coverage tests green**: `tool-pool-coverage` (group ⊆ executable), `capability-manifest` (no unclassified, every param described), `tool-guard-coverage`.
- **Full agent suite 184 files / 2336 tests PASS**; `tsc --noEmit` = 0 errors.

## Honestly NOT done (needs real DB / owner) 

- **erp-orders real store + write op** — no Prisma orders store yet; building + DB-verifying one against live order data is a separate, verified follow-up. Until then `erp-orders` is dev/test-only.
- **One R1 exactly-once write, fetch-back verified + undoable** — needs the Phase 65 engine live + a real store; owner/worker-gated.
- **"resume the same OS task after several days via its focus id"** — depends on production traffic (Phase 62 focus + this reachability, both live).

## Definition-of-Done (honest)

| Exit gate | State |
|---|---|
| Head can discover + call both OS tool families | ✅ (self-verified: in pool + groups + classified) |
| Results from real DB/ERP records | ⏳ personal-records Prisma path ready; needs live DB to prove; erp-orders needs a Prisma store |
| Service revoke immediately blocks the op | ✅ existing `assertOpAllowed` (unchanged) |
| One R1 write exactly-once + fetch-back + undoable | 0 (Phase 65 engine + real store, owner/worker) |

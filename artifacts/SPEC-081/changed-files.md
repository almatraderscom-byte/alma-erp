# SPEC-081 — Changed files (owned zones)
```
src/agent/capabilities/capability.schema.ts        (new) zod Capability + facets
src/agent/capabilities/store.ts                    (new) CapabilityStore + in-memory
src/agent/capabilities/capability-model.ts         (new) identity boundary
src/agent/capabilities/catalog.generated.ts        (new, GENERATED) 63 capabilities
src/agent/capabilities/scripts/build-catalog.ts    (new) dev-time generator (reads G08 loader)
src/agent/capabilities/index.ts                    (new) barrel
prisma/agent-capability/0001_capability_catalog.proposed.sql  (new, NOT applied)
prisma/agent-capability/README.md                  (new)
src/agent/capabilities/__tests__/capability-model.test.ts (new) 15 tests
artifacts/SPEC-081/*                                    proof
```
No live prisma/schema.prisma, no migration run, no monolith/production file touched.

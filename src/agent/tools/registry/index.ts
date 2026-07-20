/**
 * G08 — Decomposed tool registry (barrel).
 *
 * Public import surface for the tool-registry decomposition. Everything here is
 * deterministic and free of any runtime dependency on the monolith
 * (`src/agent/tools/registry.ts`), prisma, the network or a model (INV-01).
 *
 * Grows one spec at a time across G08 (SPEC-071..080).
 */
export * from './inventory.schema'
export * from './inventory'
export * from './io-schema'

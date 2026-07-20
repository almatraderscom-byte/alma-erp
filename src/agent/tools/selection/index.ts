/**
 * G10 — Tool selection firewall (barrel).
 *
 * Domain-first retrieval → exact shortlist → schema token minimization → argument
 * validation. Built on G01 contracts, G08 tool manifests/registry, G09
 * capabilities, and the G05 finops token estimator. Deterministic, no LLM/DB/
 * network at runtime (INV-01). Grows across G10 SPEC-091..094.
 */
export * from './retrieval'
export * from './shortlist'
export * from './schema-minimizer'

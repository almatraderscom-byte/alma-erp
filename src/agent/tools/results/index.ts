/**
 * G10 — Tool result firewall (barrel).
 *
 * Full evidence storage → compact model-view → deterministic summarization →
 * search/browser normalization → provenance → regression gate. The model receives
 * only bounded, sanitized, provenance-stamped views; full payloads stay in
 * evidence (INV-07). Built on G01 contracts + the G05 finops token estimator.
 * Deterministic, no LLM/DB/network at runtime (INV-01). Grows across SPEC-095..100.
 */
export * from './evidence-store'
export * from './model-view'
export * from './summarize'
export * from './normalize'

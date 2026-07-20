/**
 * G08 — Tool manifests (barrel).
 *
 * The typed manifest schema and the authored domain packages. Deterministic,
 * free of any monolith/prisma/network/model dependency (INV-01). Grows across
 * G08 (SPEC-072..078).
 */
export * from './manifest.schema'
export * from './domain-package'
export * from './derive-side-effects'
export * from './loader'

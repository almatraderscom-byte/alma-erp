/**
 * AIOS policy engine barrel (G11 / SPEC-101..110).
 *
 * The single public import surface for authorization. Outsider code depends on
 * `@/agent/policy` and reaches decisions ONLY through `decidePolicy` /
 * `PolicyEngine.decide` + the `runIfAuthorized` guard. Layer builders are
 * exported so wiring can assemble an engine; a layer's own `.evaluate` is an
 * internal contribution, never a standalone decision (enforced by bypass-gate).
 */
export * from './decision';
export * from './rbac';
export * from './abac';
export * from './relationship';
export * from './obligations';
export * from './guard';
export * from './bypass-gate';

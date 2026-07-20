/**
 * Model fabric barrel (G16).
 *
 * Vendor-neutral model tier contract + fabric (SPEC-151), the five tier handlers
 * T0→T4 (SPEC-152→156), and the provider runtime pieces re-exported for callers.
 * The head/workers import from `@/agent/models`; nothing in ERP may.
 */
export * from './tiers';
export * from './reason-codes';
export * from './registry';
export * from './ports';
export * from './contract';
export * from './tier-handler';
export * from './t0';
export * from './t1';
export * from './t2';
export * from './fabric';

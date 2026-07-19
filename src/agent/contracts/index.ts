/**
 * AIOS contracts barrel (G01 / SPEC-010).
 *
 * Single import surface for the frozen architecture contracts. Later groups
 * import from `@/agent/contracts`. One-way dependency holds: nothing in ERP
 * (`src/app`, `src/lib`) may import this (enforced by the forbidden-import gate).
 */
export * from './component';
export * from './invariants';
export * from './ownership';
export * from './execution-identity';
export * from './tenant-context';
export * from './errors';
export * from './adr';
export * from './feature-flag';
export * from './proof-artifact';
export * from './freeze';

// Pin ExecutionIdentity to its origin to avoid `export *` ambiguity (it is also
// re-exported for convenience from ./execution-identity).
export type { ExecutionIdentity } from './component';

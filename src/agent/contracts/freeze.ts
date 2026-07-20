/**
 * Architecture freeze baseline gate contract (G01 / SPEC-010).
 *
 * Declares, as typed data, the set of gates that together certify the frozen
 * architecture baseline. The runnable gate (`scripts/architecture/freeze-gate.mjs`)
 * executes these commands; this contract lets tests assert the gate covers every
 * required dimension (typecheck, tests, dependency, ownership, ADR, proof). Pure.
 */

export type FreezeGateKind = 'typecheck' | 'test' | 'dependency' | 'ownership' | 'adr' | 'proof';

export interface FreezeGateStep {
  id: string;
  kind: FreezeGateKind;
  command: string;
  /** exit 0 required for the baseline to hold */
  mustPass: true;
}

export const FREEZE_GATE_STEPS: FreezeGateStep[] = [
  { id: 'contracts-typecheck', kind: 'typecheck', command: 'tsc --noEmit -p src/agent/contracts/tsconfig.json', mustPass: true },
  { id: 'contracts-tests', kind: 'test', command: 'vitest run src/agent/contracts', mustPass: true },
  { id: 'forbidden-imports', kind: 'dependency', command: 'node scripts/architecture/check-forbidden-imports.mjs', mustPass: true },
  { id: 'ownership', kind: 'ownership', command: 'node scripts/architecture/check-ownership.mjs --owner G01', mustPass: true },
  { id: 'adr-lint', kind: 'adr', command: 'node scripts/architecture/check-adr.mjs', mustPass: true },
  { id: 'proof-complete', kind: 'proof', command: 'node scripts/architecture/check-proof.mjs --require-pass', mustPass: true },
];

export const REQUIRED_GATE_KINDS: FreezeGateKind[] = ['typecheck', 'test', 'dependency', 'ownership', 'adr', 'proof'];

/** True iff the step set covers every required gate dimension. */
export function coversAllKinds(steps: FreezeGateStep[]): boolean {
  const seen = new Set(steps.map((s) => s.kind));
  return REQUIRED_GATE_KINDS.every((k) => seen.has(k));
}

export interface FreezeStepResult {
  id: string;
  passed: boolean;
}

/** Aggregate: the baseline holds only if every mandatory step passed. */
export function freezeHolds(results: FreezeStepResult[]): boolean {
  if (results.length === 0) return false;
  return results.every((r) => r.passed);
}

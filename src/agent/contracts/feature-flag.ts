/**
 * Feature flag and rollback contract (G01 / SPEC-008).
 *
 * Realises invariant INV-08: new behaviour is feature-flagged and rollback-tested.
 * The five canonical modes and their authoritative-path semantics are frozen here
 * so every later component migrates through the same off→shadow→warn→enforce
 * ladder with an always-available rollback. Deterministic, no I/O, no LLM.
 */
import { z } from 'zod';

/**
 * off      -> legacy only
 * shadow   -> legacy authoritative, new path computed and compared
 * warn     -> new checks run and report violations (still legacy authoritative)
 * enforce  -> new path authoritative
 * rollback -> immediate legacy / last-known-good path
 */
export const FEATURE_MODES = ['off', 'shadow', 'warn', 'enforce', 'rollback'] as const;
export type FeatureMode = (typeof FEATURE_MODES)[number];

export interface FeatureFlag {
  name: string;
  mode: FeatureMode;
  /** monotonic version so a rollback can name the last-known-good */
  lastKnownGoodMode?: FeatureMode;
}

export interface ModeDecision {
  legacyAuthoritative: boolean;
  runNewPath: boolean; // compute the new path at all
  compareShadow: boolean; // compare new vs legacy without switching
  reportViolations: boolean; // surface new-path violations
  newAuthoritative: boolean; // new path decides the outcome
  isRollback: boolean;
}

const DECISIONS: Record<FeatureMode, ModeDecision> = {
  off: { legacyAuthoritative: true, runNewPath: false, compareShadow: false, reportViolations: false, newAuthoritative: false, isRollback: false },
  shadow: { legacyAuthoritative: true, runNewPath: true, compareShadow: true, reportViolations: false, newAuthoritative: false, isRollback: false },
  warn: { legacyAuthoritative: true, runNewPath: true, compareShadow: true, reportViolations: true, newAuthoritative: false, isRollback: false },
  enforce: { legacyAuthoritative: false, runNewPath: true, compareShadow: false, reportViolations: true, newAuthoritative: true, isRollback: false },
  rollback: { legacyAuthoritative: true, runNewPath: false, compareShadow: false, reportViolations: false, newAuthoritative: false, isRollback: true },
};

export const featureFlagSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(FEATURE_MODES),
  lastKnownGoodMode: z.enum(FEATURE_MODES).optional(),
});

/** Deterministic semantics for a mode. */
export function decide(mode: FeatureMode): ModeDecision {
  return DECISIONS[mode];
}

/** Legal forward transitions on the migration ladder (rollback is always legal). */
const FORWARD: Record<FeatureMode, FeatureMode[]> = {
  off: ['shadow', 'rollback'],
  shadow: ['warn', 'off', 'rollback'],
  warn: ['enforce', 'shadow', 'rollback'],
  enforce: ['warn', 'rollback'],
  rollback: ['off', 'shadow'],
};

export function canTransition(from: FeatureMode, to: FeatureMode): boolean {
  if (to === 'rollback') return true; // rollback is always reachable
  return FORWARD[from].includes(to);
}

/**
 * Produce the rollback target for a flag: its last-known-good mode, else `off`.
 * Never returns `enforce` — rollback must not re-enable the new authoritative
 * path.
 */
export function rollbackTarget(flag: FeatureFlag): FeatureMode {
  const lk = flag.lastKnownGoodMode;
  if (lk && lk !== 'enforce') return lk;
  return 'off';
}

/** Resolve a flag's mode from a registry, defaulting to `off` (fail-safe). */
export function getMode(registry: Record<string, FeatureMode>, name: string): FeatureMode {
  return registry[name] ?? 'off';
}

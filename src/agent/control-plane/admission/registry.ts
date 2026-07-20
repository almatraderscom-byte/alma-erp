/**
 * Admission stage registry (G02 / SPEC-011).
 *
 * The ordered list of deterministic stages the gateway runs. SPEC-011 ships it
 * empty (identity validation alone is the baseline door); later G02 specs append
 * their stage here — one registration line per spec, keeping each spec's diff
 * self-contained. `admit()` defaults to this ordered list.
 */
import type { AdmissionStage } from './gateway';
import { normalizeStage } from './normalize';
import { fastPathStage } from './fast-path';
import { intentStage } from './intent';
import { complexityStage } from './complexity';
import { planningStage } from './planning';

export const ADMISSION_STAGES: AdmissionStage[] = [
  normalizeStage, // SPEC-012
  fastPathStage, // SPEC-013
  intentStage, // SPEC-015
  complexityStage, // SPEC-016
  planningStage, // SPEC-017
  // SPEC-018 risk, SPEC-019 dedup — appended below.
];

export function admissionPipeline(): AdmissionStage[] {
  return ADMISSION_STAGES;
}

/**
 * Admission stage registry (G02 / SPEC-011).
 *
 * The ordered list of deterministic stages the gateway runs. SPEC-011 ships it
 * empty (identity validation alone is the baseline door); later G02 specs append
 * their stage here — one registration line per spec, keeping each spec's diff
 * self-contained. `admit()` defaults to this ordered list.
 */
import type { AdmissionStage } from './gateway';

export const ADMISSION_STAGES: AdmissionStage[] = [
  // SPEC-012 normalize, SPEC-013 fast-path, SPEC-015..018 classifiers,
  // SPEC-019 dedup — appended in numeric order as each spec lands.
];

export function admissionPipeline(): AdmissionStage[] {
  return ADMISSION_STAGES;
}

/**
 * AI change-proof artifact standard (G01 / SPEC-009).
 *
 * Realises invariant INV-10: completion requires executable proof, not an
 * explanation. Defines the required proof-artifact set for every spec and a
 * validator that a proof directory is complete and its verdict is well-formed.
 * Pure: operates on filenames + verdict text supplied by the caller (the script
 * does the filesystem read). No I/O here, no LLM.
 */

export const REQUIRED_PROOF_ARTIFACTS = [
  'baseline.md',
  'contract.md',
  'changed-files.md',
  'test-results.md',
  'architecture-scan.md',
  'cost-before-after.md',
  'security-proof.md',
  'rollback-proof.md',
  'unresolved-risks.md',
  'final-verdict.md',
] as const;

export type ProofArtifact = (typeof REQUIRED_PROOF_ARTIFACTS)[number];

export const VERDICTS = ['PASS', 'PARTIAL', 'FAIL'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ProofIssue {
  code: 'MISSING_ARTIFACT' | 'NO_VERDICT' | 'BAD_VERDICT';
  detail: string;
}

/** Extract the verdict from a final-verdict.md body. Returns null if absent. */
export function verdictOf(finalVerdictBody: string): Verdict | null {
  const m = /\bVerdict:\s*\**\s*(PASS|PARTIAL|FAIL)\b/i.exec(finalVerdictBody);
  if (!m) return null;
  return m[1].toUpperCase() as Verdict;
}

export interface ProofValidation {
  complete: boolean;
  verdict: Verdict | null;
  issues: ProofIssue[];
}

/**
 * Validate one spec's proof directory.
 * @param presentFiles filenames present in artifacts/SPEC-XXX/
 * @param finalVerdictBody contents of final-verdict.md ('' if missing)
 */
export function validateProof(presentFiles: string[], finalVerdictBody: string): ProofValidation {
  const present = new Set(presentFiles);
  const issues: ProofIssue[] = [];
  for (const req of REQUIRED_PROOF_ARTIFACTS) {
    if (!present.has(req)) issues.push({ code: 'MISSING_ARTIFACT', detail: req });
  }
  const verdict = verdictOf(finalVerdictBody);
  if (verdict === null) {
    issues.push({ code: 'NO_VERDICT', detail: 'final-verdict.md has no "Verdict: PASS|PARTIAL|FAIL"' });
  }
  return {
    complete: issues.filter((i) => i.code === 'MISSING_ARTIFACT').length === 0,
    verdict,
    issues,
  };
}

/** A spec may advance the Group Runner only when complete AND verdict === PASS. */
export function isAdvanceable(v: ProofValidation): boolean {
  return v.complete && v.verdict === 'PASS';
}

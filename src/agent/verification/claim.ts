/**
 * Evidence-backed claim verifier (G19 / SPEC-182).
 *
 * The agent may only tell the owner things it can back with EVIDENCE. Every claim
 * cites one or more evidence references (tool-result / evidence ids from G10/G13);
 * a claim with no citation, or that cites an evidence id that does not exist, is
 * UNBACKED and must not reach the owner. This deterministically separates verified
 * statements from hallucinations (INV-01, no LLM judges truth here).
 *
 * Returns COMPLETED only when every claim is backed; otherwise FAILED_FINAL
 * listing the unbacked claims (fail-closed).
 */
import type { ComponentResult } from '@/agent/contracts';

export interface Claim {
  id: string;
  text: string;
  evidenceRefs: string[];
}

export const CLAIM_REASON_CODES = {
  UNBACKED: 'VERIFY_CLAIM_UNBACKED',
  NO_CITATION: 'VERIFY_CLAIM_NO_CITATION',
} as const;

export interface ClaimVerification {
  ok: boolean;
  unbacked: string[];
}

/** Which claims are unbacked given the set of known evidence ids. */
export function findUnbackedClaims(claims: Claim[], knownEvidenceIds: ReadonlySet<string>): string[] {
  const unbacked: string[] = [];
  for (const c of claims) {
    if (c.evidenceRefs.length === 0) { unbacked.push(c.id); continue; }
    const backed = c.evidenceRefs.some((ref) => knownEvidenceIds.has(ref));
    if (!backed) unbacked.push(c.id);
  }
  return unbacked;
}

/**
 * Verify every claim is evidence-backed. COMPLETED only when all are backed;
 * otherwise FAILED_FINAL with the unbacked claim ids (fail-closed — an uncited
 * claim never counts as verified).
 */
export function verifyClaims(claims: Claim[], knownEvidenceIds: ReadonlySet<string>): ComponentResult<{ verified: true }> {
  const unbacked = findUnbackedClaims(claims, knownEvidenceIds);
  if (unbacked.length > 0) {
    return { status: 'FAILED_FINAL', reasonCodes: [CLAIM_REASON_CODES.UNBACKED, ...unbacked], evidenceIds: [] };
  }
  return { status: 'COMPLETED', value: { verified: true }, evidenceIds: [...knownEvidenceIds].slice(0, 0), versions: { claim: 'SPEC-182' } };
}

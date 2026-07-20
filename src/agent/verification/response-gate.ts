/**
 * User-response gate (G19 / SPEC-183).
 *
 * The last door before anything reaches the owner. A response is released ONLY if:
 * every postcondition verified (SPEC-181), every claim is evidence-backed
 * (SPEC-182), no secret leaked into the text, and no banned form of address is
 * used ("Sir"/"স্যার" are forbidden — owner rule; the agent says "Boss"). Anything
 * else is blocked (fail-closed, INV-05). Deterministic — no LLM decides release.
 */
import type { ComponentResult } from '@/agent/contracts';
import { verifyPostcondition, type Postcondition } from './postcondition';
import { verifyClaims, type Claim } from './claim';

export const RESPONSE_GATE_REASON_CODES = {
  POSTCONDITION_FAILED: 'RESPONSE_POSTCONDITION_FAILED',
  UNBACKED_CLAIM: 'RESPONSE_UNBACKED_CLAIM',
  SECRET_LEAK: 'RESPONSE_SECRET_LEAK',
  BANNED_ADDRESS: 'RESPONSE_BANNED_ADDRESS',
} as const;

const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{8,}/, /-----BEGIN [A-Z ]+PRIVATE KEY-----/, /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9]{12,}/i];
const BANNED_ADDRESS = [/\bSir\b/, /স্যার/];

export interface ResponseGateInput {
  responseText: string;
  claims: Claim[];
  knownEvidenceIds: ReadonlySet<string>;
  postconditions: Array<{ post: Postcondition; observed: unknown }>;
}

/**
 * Gate an owner-facing response. Returns ALLOWED with the text if every check
 * passes, or DENIED with the accumulated reason codes.
 */
export function gateUserResponse(input: ResponseGateInput): ComponentResult<{ text: string }> {
  const reasons: string[] = [];

  for (const { post, observed } of input.postconditions) {
    if (verifyPostcondition(post, observed).status !== 'COMPLETED') {
      reasons.push(`${RESPONSE_GATE_REASON_CODES.POSTCONDITION_FAILED}:${post.id}`);
    }
  }
  if (verifyClaims(input.claims, input.knownEvidenceIds).status !== 'COMPLETED') {
    reasons.push(RESPONSE_GATE_REASON_CODES.UNBACKED_CLAIM);
  }
  if (SECRET_PATTERNS.some((re) => re.test(input.responseText))) {
    reasons.push(RESPONSE_GATE_REASON_CODES.SECRET_LEAK);
  }
  if (BANNED_ADDRESS.some((re) => re.test(input.responseText))) {
    reasons.push(RESPONSE_GATE_REASON_CODES.BANNED_ADDRESS);
  }

  if (reasons.length > 0) {
    return { status: 'DENIED', reasonCodes: reasons, evidenceIds: [] };
  }
  return { status: 'ALLOWED', value: { text: input.responseText }, evidenceIds: [], versions: { responseGate: 'SPEC-183' } };
}

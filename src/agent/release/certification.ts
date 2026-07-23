/**
 * Final architecture certification (G20 / SPEC-200).
 *
 * The single deterministic authority that converts EXECUTABLE evidence — gate
 * step results, per-spec proof verdicts, and the release checklist — into one
 * typed certification verdict. Constitution rule 10: certification claims are
 * generated from executable proof, never from roadmap status text.
 *
 * Fail-closed by construction:
 *  - missing identity → DENIED
 *  - malformed / oversized evidence → FAILED_FINAL
 *  - any required gate step absent or non-PASS → DENIED
 *  - any spec id missing from SPEC-001..SPEC-<expectedSpecCount>, any non-PASS
 *    verdict, or any missing proof artifact → DENIED
 *  - any unsatisfied checklist item, or one lacking an evidence reference → DENIED
 *
 * Pure + deterministic (INV-01): evidence is passed in, never fetched; the same
 * inputs always produce the same verdict and the same certification digest.
 * The runner (`scripts/architecture/certify-architecture.mjs`) executes the real
 * gates and feeds their machine-readable output through these exact rules.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  COMPONENT_CONTRACT_VERSION,
  REASON_CODES,
  executionIdentitySchema,
  type ComponentRequest,
  type ComponentResult,
} from '@/agent/contracts';

export const CERTIFICATION_CONTRACT_VERSION = '1.0.0' as const;

/** The gate steps that MUST be present and PASS — the frozen spine's proof. */
export const REQUIRED_GATE_STEPS = Object.freeze([
  'contracts-typecheck',
  'contracts-tests',
  'forbidden-imports',
  'ownership',
  'adr-lint',
  'proof-complete',
] as const);

/** Closed reason-code set for certification denials (append-only). */
export const CERT_REASON_CODES = Object.freeze({
  GATE_STEP_MISSING: 'GATE_STEP_MISSING',
  GATE_STEP_FAILED: 'GATE_STEP_FAILED',
  SPEC_SET_INCOMPLETE: 'SPEC_SET_INCOMPLETE',
  SPEC_PROOF_MISSING: 'SPEC_PROOF_MISSING',
  SPEC_VERDICT_NOT_PASS: 'SPEC_VERDICT_NOT_PASS',
  CHECKLIST_UNSATISFIED: 'CHECKLIST_UNSATISFIED',
  CHECKLIST_NO_EVIDENCE: 'CHECKLIST_NO_EVIDENCE',
} as const);

const gateStepSchema = z.object({
  id: z.string().min(1).max(80),
  verdict: z.enum(['PASS', 'FAIL']),
});

const specProofSchema = z.object({
  /** e.g. "SPEC-141" */
  spec: z.string().regex(/^SPEC-\d{3}$/),
  verdict: z.enum(['PASS', 'PARTIAL', 'FAIL']).nullable(),
  /** required-artifact filenames absent from the proof dir */
  missing: z.array(z.string().max(120)).max(20),
});

const checklistItemSchema = z.object({
  id: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  satisfied: z.boolean(),
  /** pointer to executable evidence (test file, gate id, trace…) — never blank */
  evidenceRef: z.string().max(400),
});

export const certificationPayloadSchema = z.object({
  /** Total specs the program requires (200). Bounded to keep input sane. */
  expectedSpecCount: z.number().int().min(1).max(1000),
  auditedCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  gateSteps: z.array(gateStepSchema).max(50),
  specProofs: z.array(specProofSchema).max(1000),
  checklist: z.array(checklistItemSchema).max(200),
});

export type CertificationPayload = z.infer<typeof certificationPayloadSchema>;

export interface CertificationSummary {
  certified: true;
  auditedCommit: string;
  specCount: number;
  gateSteps: number;
  checklistItems: number;
  /** sha256 over the canonical evidence — same evidence ⇒ same digest. */
  digest: string;
}

/** Canonical JSON (sorted keys at every level) so the digest is stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export function certificationDigest(payload: CertificationPayload): string {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

/**
 * The certification decision. Pure; throws never.
 */
export function certifyArchitecture(
  req: ComponentRequest<CertificationPayload>,
): ComponentResult<CertificationSummary> {
  // Identity — fail closed before touching the payload.
  const id = executionIdentitySchema.safeParse(req?.identity);
  if (!id.success) {
    return { status: 'DENIED', reasonCodes: [REASON_CODES.MISSING_TENANT], evidenceIds: [] };
  }
  if (req.contractVersion !== COMPONENT_CONTRACT_VERSION) {
    return { status: 'FAILED_FINAL', reasonCodes: [REASON_CODES.CONTRACT_VERSION_MISMATCH], evidenceIds: [] };
  }
  const parsed = certificationPayloadSchema.safeParse(req.payload);
  if (!parsed.success) {
    return { status: 'FAILED_FINAL', reasonCodes: [REASON_CODES.MALFORMED_INPUT], evidenceIds: [] };
  }
  const p = parsed.data;
  const reasons = new Set<string>();
  const evidenceIds: string[] = [];

  // 1) Required gate steps: all present, all PASS.
  const gateById = new Map(p.gateSteps.map((g) => [g.id, g.verdict]));
  for (const required of REQUIRED_GATE_STEPS) {
    const v = gateById.get(required);
    if (v === undefined) reasons.add(CERT_REASON_CODES.GATE_STEP_MISSING);
    else if (v !== 'PASS') reasons.add(CERT_REASON_CODES.GATE_STEP_FAILED);
    else evidenceIds.push(`gate:${required}`);
  }

  // 2) Spec set completeness: SPEC-001..SPEC-<expected> each present exactly,
  //    complete (no missing artifacts) and PASS. Unknown/absent verdict fails.
  const proofBySpec = new Map(p.specProofs.map((s) => [s.spec, s]));
  for (let n = 1; n <= p.expectedSpecCount; n++) {
    const specId = `SPEC-${String(n).padStart(3, '0')}`;
    const proof = proofBySpec.get(specId);
    if (!proof) {
      reasons.add(CERT_REASON_CODES.SPEC_SET_INCOMPLETE);
      continue;
    }
    if (proof.missing.length > 0) reasons.add(CERT_REASON_CODES.SPEC_PROOF_MISSING);
    if (proof.verdict !== 'PASS') reasons.add(CERT_REASON_CODES.SPEC_VERDICT_NOT_PASS);
  }
  if (
    !reasons.has(CERT_REASON_CODES.SPEC_SET_INCOMPLETE) &&
    !reasons.has(CERT_REASON_CODES.SPEC_PROOF_MISSING) &&
    !reasons.has(CERT_REASON_CODES.SPEC_VERDICT_NOT_PASS)
  ) {
    evidenceIds.push(`specs:${p.expectedSpecCount}`);
  }

  // 3) Release checklist: every item satisfied AND backed by evidence.
  for (const item of p.checklist) {
    if (!item.satisfied) reasons.add(CERT_REASON_CODES.CHECKLIST_UNSATISFIED);
    else if (item.evidenceRef.trim().length === 0) reasons.add(CERT_REASON_CODES.CHECKLIST_NO_EVIDENCE);
  }
  if (p.checklist.length > 0 && ![...reasons].some((r) => r.startsWith('CHECKLIST'))) {
    evidenceIds.push(`checklist:${p.checklist.length}`);
  }

  if (reasons.size > 0) {
    return {
      status: 'DENIED',
      reasonCodes: [REASON_CODES.POLICY_DENIED, ...[...reasons].sort()],
      evidenceIds,
    };
  }

  return {
    status: 'COMPLETED',
    value: {
      certified: true,
      auditedCommit: p.auditedCommit,
      specCount: p.expectedSpecCount,
      gateSteps: p.gateSteps.length,
      checklistItems: p.checklist.length,
      digest: certificationDigest(p),
    },
    evidenceIds,
    versions: {
      certification: CERTIFICATION_CONTRACT_VERSION,
      component: COMPONENT_CONTRACT_VERSION,
    },
  };
}

/**
 * Complexity classification (G02 / SPEC-016).
 *
 * Deterministic estimate of how much work a request implies — SIMPLE / STANDARD
 * / COMPLEX — from cheap signals (length, attachments, conjunction/step markers).
 * Feeds routing and cost-tier selection later (G04/G17). No model (INV-01).
 */
import type { AdmissionStage } from './gateway';
import type { NormalizedRequest } from './normalize';

export const COMPLEXITY_CLASSES = ['SIMPLE', 'STANDARD', 'COMPLEX'] as const;
export type ComplexityClass = (typeof COMPLEXITY_CLASSES)[number];

const STEP_MARKERS = /\b(and then|after that|then|next|also|ar por|tarpor|ebong)\b/gi;

export interface ComplexityResult {
  complexity: ComplexityClass;
  score: number;
  signals: string[];
}

export function classifyComplexity(n: NormalizedRequest): ComplexityResult {
  const signals: string[] = [];
  let score = 0;

  const len = n.text.length;
  if (len > 400) { score += 2; signals.push('long-text'); }
  else if (len > 120) { score += 1; signals.push('medium-text'); }

  if (n.hasAttachments) { score += 1; signals.push('attachments'); }

  const stepMatches = n.text.match(STEP_MARKERS);
  if (stepMatches && stepMatches.length >= 2) { score += 2; signals.push('multi-step'); }
  else if (stepMatches && stepMatches.length === 1) { score += 1; signals.push('step-marker'); }

  const sentences = n.text.split(/[.!?।]/).filter((s) => s.trim().length > 0);
  if (sentences.length >= 3) { score += 1; signals.push('multi-sentence'); }

  const complexity: ComplexityClass = score >= 3 ? 'COMPLEX' : score >= 1 ? 'STANDARD' : 'SIMPLE';
  return { complexity, score, signals };
}

export const complexityStage: AdmissionStage = {
  id: 'complexity',
  run(ctx) {
    const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
    if (!normalized) return { ok: true, ctx };
    const result = classifyComplexity(normalized);
    return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, complexity: result.complexity, complexityResult: result } } };
  },
};

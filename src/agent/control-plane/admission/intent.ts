/**
 * Intent classification adapter (G02 / SPEC-015).
 *
 * Classifies WHAT a request wants. Structured as an ADAPTER seam: the default is
 * a deterministic keyword classifier (no model, INV-01). A model-backed adapter
 * may be plugged later, but only as a BOUNDED call pre-authorised by the Cost
 * Governor (G04) — never an unbounded model call from admission. The seam keeps
 * that future swap from touching the gateway.
 */
import type { AdmissionStage } from './gateway';
import type { NormalizedRequest } from './normalize';

export const INTENT_CLASSES = ['command', 'question', 'task', 'chitchat', 'unknown'] as const;
export type IntentClass = (typeof INTENT_CLASSES)[number];

export interface IntentResult {
  intent: IntentClass;
  confidence: number; // 0..1
  via: 'deterministic' | 'model';
}

export interface IntentAdapter {
  readonly id: string;
  classify(normalized: NormalizedRequest): IntentResult;
}

const QUESTION_STARTERS = /^(who|what|when|where|why|how|which|is|are|can|could|do|does|did|should|koto|ki|kokhon|keno|kivabe|kothay)\b/i;
const TASK_VERBS = /^(create|make|send|update|delete|add|remove|schedule|post|generate|pay|order|banao|pathao|toiri|koro)\b/i;

/** Deterministic default — no model, fully replayable. */
export const deterministicIntentAdapter: IntentAdapter = {
  id: 'deterministic',
  classify(n) {
    if (n.command) return { intent: 'command', confidence: 1, via: 'deterministic' };
    const t = n.text.trim();
    if (t.length === 0) return { intent: 'unknown', confidence: 1, via: 'deterministic' };
    if (t.endsWith('?') || QUESTION_STARTERS.test(t)) return { intent: 'question', confidence: 0.8, via: 'deterministic' };
    if (TASK_VERBS.test(t)) return { intent: 'task', confidence: 0.8, via: 'deterministic' };
    return { intent: 'chitchat', confidence: 0.5, via: 'deterministic' };
  },
};

export function classifyIntent(n: NormalizedRequest, adapter: IntentAdapter = deterministicIntentAdapter): IntentResult {
  return adapter.classify(n);
}

export const intentStage: AdmissionStage = {
  id: 'intent',
  run(ctx) {
    const normalized = ctx.annotations.normalized as NormalizedRequest | undefined;
    if (!normalized) return { ok: true, ctx };
    const result = classifyIntent(normalized);
    return { ok: true, ctx: { ...ctx, annotations: { ...ctx.annotations, intent: result.intent, intentResult: result } } };
  },
};

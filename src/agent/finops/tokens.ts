/**
 * Tokenizer abstraction and token estimation (G03 / SPEC-022).
 *
 * Cost estimation needs a token count BEFORE a call, so this is an adapter seam:
 * a deterministic heuristic estimator ships as the default (no model, no native
 * tokenizer dependency), and a provider-accurate tokenizer can be plugged later
 * without changing the estimators. Deterministic and pure.
 */

/** Usage shape shared by estimators and reconciliation (SPEC-024/027). */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolCalls: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
};

export interface TokenEstimator {
  readonly id: string;
  estimate(text: string): number;
}

/**
 * Deterministic heuristic: ~4 characters per token, with a small floor so short
 * non-empty strings still cost ≥1 token. Intentionally a slight OVER-estimate on
 * whitespace-light text so budgeting errs safe. Replaceable by a real tokenizer.
 */
export const heuristicTokenEstimator: TokenEstimator = {
  id: 'heuristic-chars-4',
  estimate(text: string): number {
    if (!text) return 0;
    const chars = text.length;
    return Math.max(1, Math.ceil(chars / 4));
  },
};

export function estimateTokens(text: string, estimator: TokenEstimator = heuristicTokenEstimator): number {
  return estimator.estimate(text);
}

/** Build a TokenUsage from prompt/expected-output text using an estimator. */
export function estimateUsage(
  input: { promptText: string; expectedOutputText?: string; expectedOutputTokens?: number; toolCalls?: number },
  estimator: TokenEstimator = heuristicTokenEstimator,
): TokenUsage {
  const inputTokens = estimateTokens(input.promptText, estimator);
  const outputTokens =
    input.expectedOutputTokens ??
    (input.expectedOutputText ? estimateTokens(input.expectedOutputText, estimator) : 0);
  return {
    ...EMPTY_USAGE,
    inputTokens,
    outputTokens,
    toolCalls: input.toolCalls ?? 0,
  };
}

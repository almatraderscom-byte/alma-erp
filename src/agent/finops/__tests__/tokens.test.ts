import { describe, it, expect } from 'vitest';
import {
  EMPTY_USAGE,
  estimateTokens,
  estimateUsage,
  heuristicTokenEstimator,
  type TokenEstimator,
} from '../tokens';

describe('heuristic token estimator', () => {
  it('returns 0 for empty text and ≥1 for any non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
  });

  it('approximates ~4 chars per token, deterministically', () => {
    expect(estimateTokens('12345678')).toBe(2); // 8/4
    expect(estimateTokens('hello world!')).toBe(3); // 12/4
    expect(estimateTokens('abc')).toBe(estimateTokens('abc')); // stable
  });

  it('exposes a stable id (for evidence)', () => {
    expect(heuristicTokenEstimator.id).toBe('heuristic-chars-4');
  });
});

describe('adapter seam', () => {
  it('accepts a pluggable estimator', () => {
    const fixed: TokenEstimator = { id: 'fixed', estimate: () => 42 };
    expect(estimateTokens('whatever', fixed)).toBe(42);
  });
});

describe('estimateUsage', () => {
  it('builds usage from prompt + expected output text', () => {
    const u = estimateUsage({ promptText: '12345678', expectedOutputText: '1234' });
    expect(u.inputTokens).toBe(2);
    expect(u.outputTokens).toBe(1);
    expect(u).toMatchObject({ cachedInputTokens: 0, reasoningTokens: 0, toolCalls: 0 });
  });

  it('honours explicit expectedOutputTokens + toolCalls', () => {
    const u = estimateUsage({ promptText: 'x', expectedOutputTokens: 500, toolCalls: 3 });
    expect(u.outputTokens).toBe(500);
    expect(u.toolCalls).toBe(3);
  });

  it('EMPTY_USAGE is all zeros', () => {
    expect(EMPTY_USAGE).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, toolCalls: 0 });
  });
});

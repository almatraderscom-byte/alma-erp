/**
 * Deterministic FAKE provider adapter (G16 / SPEC-151).
 *
 * The ONLY adapter implementation shipped by this group. It performs zero I/O
 * and zero network calls: every outcome is a pure function of the call plus an
 * optional scripted rule set. This is what lets the whole model fabric be tested
 * deterministically (INV-01) with no API keys and no provider dependency.
 *
 * Determinism guarantees:
 *  - default outcome is `OK` with text derived from the prompt by a stable hash;
 *  - usage is derived from the prompt/output by the finops heuristic estimator;
 *  - scripted rules let a test force TIMEOUT / RETRYABLE / FINAL / UNKNOWN or a
 *    canned JSON/text body for a specific call — always without randomness.
 */
import { estimateTokens, EMPTY_USAGE, type TokenUsage } from '@/agent/finops/tokens';
import type { AdapterCall, AdapterOutcome, ProviderAdapter } from './adapter';

/** A scripted rule: when `match` is true, produce `outcome`. */
export interface FakeRule {
  match: (call: AdapterCall) => boolean;
  outcome: AdapterOutcome | ((call: AdapterCall) => AdapterOutcome);
}

export interface FakeAdapterOptions {
  provider: string;
  /** models this fake claims to serve; empty means "serve any model" */
  models?: string[];
  /** ordered rules; first match wins; falls through to the default OK body */
  rules?: FakeRule[];
}

/** Stable, non-cryptographic hash → deterministic bodies without randomness. */
function stableHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic default body for a call, honouring the requested modality. */
export function fakeBody(call: AdapterCall): string {
  const tag = stableHash(`${call.model}|${call.responseFormat}|${call.prompt}`);
  if (call.responseFormat === 'json') {
    return JSON.stringify({ model: call.model, echo: tag });
  }
  return `FAKE(${call.model}):${tag}`;
}

/** Build a deterministic OK outcome (usage derived from prompt + body). */
export function fakeOk(call: AdapterCall, body?: string): AdapterOutcome {
  const text = body ?? fakeBody(call);
  const inputTokens = estimateTokens(call.prompt);
  // never claim more output than the caller allowed; mark `length` if clamped
  const rawOutput = estimateTokens(text);
  const outputTokens = Math.min(rawOutput, call.maxOutputTokens);
  const usage: TokenUsage = { ...EMPTY_USAGE, inputTokens, outputTokens };
  return {
    kind: 'OK',
    text,
    usage,
    finishReason: outputTokens < rawOutput ? 'length' : 'stop',
  };
}

/**
 * Create a deterministic fake adapter. With no rules it always returns a stable
 * OK body; rules let a test force specific failure/latency classes per call.
 */
export function createFakeAdapter(opts: FakeAdapterOptions): ProviderAdapter & {
  /** number of invocations seen (deterministic call-count assertions) */
  readonly calls: AdapterCall[];
} {
  const models = opts.models ?? [];
  const rules = opts.rules ?? [];
  const calls: AdapterCall[] = [];
  return {
    provider: opts.provider,
    calls,
    supports(model: string): boolean {
      return models.length === 0 || models.includes(model);
    },
    async invoke(call: AdapterCall): Promise<AdapterOutcome> {
      calls.push(call);
      for (const rule of rules) {
        if (rule.match(call)) {
          return typeof rule.outcome === 'function' ? rule.outcome(call) : rule.outcome;
        }
      }
      return fakeOk(call);
    },
  };
}

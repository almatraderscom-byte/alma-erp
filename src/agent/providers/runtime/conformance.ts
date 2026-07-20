/**
 * Model adapter conformance harness (G16 / SPEC-160).
 *
 * A reusable, deterministic battery that any `ProviderAdapter` implementation
 * must pass before the fabric is allowed to route to it. It is the executable
 * definition of the adapter contract: run it against the FAKE adapters here, and
 * against every real SDK adapter added later (the documented seam) — a real
 * adapter is only "ready" once it passes this harness against recorded fixtures,
 * with no live network call.
 *
 * The harness never throws: it returns a structured `ConformanceReport` so it can
 * be asserted on, logged, or gated in CI.
 *
 * Contract checked:
 *  - `supports(model)` is true for the model under test;
 *  - `invoke` resolves to a valid discriminated `AdapterOutcome` (never throws);
 *  - an OK outcome has non-negative integer usage, a valid `finishReason`, output
 *    within `maxOutputTokens`, and — for `json` format — parseable JSON text;
 *  - error outcomes are well-formed (RETRYABLE/FINAL carry a `providerCode`);
 *  - identical input yields an identical outcome (deterministic).
 */
import type { AdapterCall, AdapterOutcome, ProviderAdapter } from './adapter';

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  adapter: string;
  model: string;
  passed: boolean;
  checks: ConformanceCheck[];
}

const VALID_KINDS = new Set(['OK', 'TIMEOUT', 'RETRYABLE', 'FINAL', 'UNKNOWN']);

function isNonNegInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Validate a single outcome against the adapter contract. Returns issue strings. */
export function validateOutcome(outcome: AdapterOutcome, call: AdapterCall): string[] {
  const issues: string[] = [];
  if (!outcome || !VALID_KINDS.has((outcome as { kind?: string }).kind ?? '')) {
    return [`invalid outcome kind: ${JSON.stringify(outcome)}`];
  }
  if (outcome.kind === 'OK') {
    if (typeof outcome.text !== 'string') issues.push('OK.text is not a string');
    const u = outcome.usage;
    for (const k of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'toolCalls'] as const) {
      if (!isNonNegInt(u?.[k])) issues.push(`usage.${k} is not a non-negative integer`);
    }
    if (outcome.finishReason !== 'stop' && outcome.finishReason !== 'length') issues.push('invalid finishReason');
    if (isNonNegInt(u?.outputTokens) && u.outputTokens > call.maxOutputTokens) issues.push('outputTokens exceeds maxOutputTokens');
    if (call.responseFormat === 'json' && typeof outcome.text === 'string') {
      try {
        JSON.parse(outcome.text);
      } catch {
        issues.push('json responseFormat but text is not parseable JSON');
      }
    }
  } else if (outcome.kind === 'RETRYABLE' || outcome.kind === 'FINAL') {
    if (typeof outcome.providerCode !== 'string' || outcome.providerCode.length === 0) {
      issues.push(`${outcome.kind} outcome missing providerCode`);
    }
  }
  return issues;
}

/** Standard sample calls (text + json) for a model. */
export function standardSampleCalls(model: string, provider: string): AdapterCall[] {
  const base = { provider, model, maxOutputTokens: 256, timeoutMs: 10_000, correlationId: 'conformance' };
  return [
    { ...base, prompt: 'conformance: text sample', responseFormat: 'text' },
    { ...base, prompt: 'conformance: json sample', responseFormat: 'json' },
  ];
}

export interface ConformanceOptions {
  model: string;
  sampleCalls?: AdapterCall[];
}

/** Run the full conformance battery against an adapter. Never throws. */
export async function runAdapterConformance(adapter: ProviderAdapter, opts: ConformanceOptions): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const model = opts.model;
  const calls = opts.sampleCalls ?? standardSampleCalls(model, adapter.provider);

  checks.push({ name: 'supports-model', ok: adapter.supports(model) === true, detail: `supports(${model})` });

  for (const call of calls) {
    let outcome: AdapterOutcome | undefined;
    let threw = false;
    try {
      outcome = await adapter.invoke(call);
    } catch (e) {
      threw = true;
      checks.push({ name: `invoke-no-throw:${call.responseFormat}`, ok: false, detail: String(e) });
    }
    if (threw || !outcome) continue;
    checks.push({ name: `invoke-no-throw:${call.responseFormat}`, ok: true });

    const issues = validateOutcome(outcome, call);
    checks.push({ name: `outcome-valid:${call.responseFormat}`, ok: issues.length === 0, detail: issues.join('; ') || undefined });

    // determinism: identical input → identical outcome
    const again = await adapter.invoke(call);
    const deterministic = JSON.stringify(again) === JSON.stringify(outcome);
    checks.push({ name: `deterministic:${call.responseFormat}`, ok: deterministic });
  }

  const passed = checks.every((c) => c.ok);
  return { adapter: adapter.provider, model, passed, checks };
}

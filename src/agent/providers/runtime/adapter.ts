/**
 * Provider runtime adapter interface (G16 / SPEC-151).
 *
 * The single seam between the vendor-neutral model fabric and a concrete LLM
 * provider (Google, OpenRouter, Anthropic, …). The fabric only ever speaks this
 * interface; it never imports a provider SDK. Real SDK wiring is a *documented
 * seam*: a production adapter implements `ProviderAdapter` and performs the HTTP
 * call, but that lives outside this group and is never exercised in tests.
 *
 * CRITICAL: nothing in this zone performs a real network call. The only adapter
 * shipped here is the deterministic FAKE (`fake-adapter.ts`).
 *
 * Deterministic, typed, no ambiguous booleans: an invocation returns a
 * discriminated `AdapterOutcome`, never a thrown provider error.
 */
import type { TokenUsage } from '@/agent/finops/tokens';

/** What shape of output the caller expects back from the provider. */
export type AdapterModality = 'text' | 'json';

/**
 * A single, fully-bounded provider call. The `prompt` is the *bounded view* the
 * model receives (INV-07) — full payloads stay in evidence storage upstream.
 */
export interface AdapterCall {
  provider: string;
  model: string;
  prompt: string;
  responseFormat: AdapterModality;
  maxOutputTokens: number;
  /** hard wall-clock bound; the adapter must not exceed it */
  timeoutMs: number;
  temperature?: number;
  /** correlation only — NOT the full payload */
  correlationId: string;
}

export type AdapterFinishReason = 'stop' | 'length';

/**
 * The result of an invocation. Every non-OK outcome is explicit and classified
 * so the fabric can map it to a canonical failure without inspecting exceptions:
 *  - TIMEOUT    → wall-clock bound exceeded (RETRYABLE upstream)
 *  - RETRYABLE  → provider signalled a transient error (429/503/…)
 *  - FINAL      → provider signalled a permanent error (400/auth/…)
 *  - UNKNOWN    → outcome could not be determined → reconciliation, never blind retry (INV-06)
 */
export type AdapterOutcome =
  | { kind: 'OK'; text: string; usage: TokenUsage; finishReason: AdapterFinishReason }
  | { kind: 'TIMEOUT' }
  | { kind: 'RETRYABLE'; providerCode: string }
  | { kind: 'FINAL'; providerCode: string }
  | { kind: 'UNKNOWN'; providerCode?: string };

/** A provider adapter. Pure interface — implementations may be fake or real. */
export interface ProviderAdapter {
  readonly provider: string;
  /** true if this adapter can serve the given model id */
  supports(model: string): boolean;
  /** perform the (bounded) call; never throws across the boundary */
  invoke(call: AdapterCall): Promise<AdapterOutcome>;
}

/** Resolve a provider id → adapter. Returns null when no adapter is registered. */
export interface AdapterResolver {
  resolve(provider: string): ProviderAdapter | null;
}

/** Simple in-memory resolver over a fixed adapter set (used by fabric + tests). */
export function createAdapterResolver(adapters: ProviderAdapter[]): AdapterResolver {
  const byProvider = new Map<string, ProviderAdapter>();
  for (const a of adapters) byProvider.set(a.provider, a);
  return {
    resolve(provider: string): ProviderAdapter | null {
      return byProvider.get(provider) ?? null;
    },
  };
}

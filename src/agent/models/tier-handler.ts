/**
 * Tier handler interface (G16 / SPEC-151).
 *
 * Each tier plugs a `TierHandler` into the fabric. A handler decides whether a
 * request is admissible for its tier and produces either:
 *   - RESOLVED : a fully-deterministic value with NO provider call (T0), or
 *   - INVOKE   : the constraints for a bounded provider call, or
 *   - FAILURE  : a typed rejection.
 * After the provider returns, `finalize` shapes/validates the raw text into the
 * tier's value contract.
 *
 * SPEC-151 defines the interface and an empty default registry; each later spec
 * (152→156) registers exactly one tier's handler. The fabric fails closed with
 * MODEL_TIER_NOT_IMPLEMENTED for any tier without a handler.
 */
import type { ComponentFailure } from '@/agent/contracts';
import type { AdapterModality } from '@/agent/providers/runtime/adapter';
import type { ModelInvocationPayload, ModelInvocationValue } from './contract';
import type { ModelTier, TierDefinition } from './tiers';
import type { TierModelRegistry } from './registry';
import type { Clock } from './ports';

/** Concrete per-call constraints a handler emits for a provider invocation. */
export interface TierConstraints {
  provider: string;
  model: string;
  role?: string;
  responseFormat: AdapterModality;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface TierPrepareContext {
  registry: TierModelRegistry;
  clock: Clock;
}

export type TierPrepared =
  | { kind: 'INVOKE'; constraints: TierConstraints }
  | { kind: 'RESOLVED'; value: ModelInvocationValue }
  | { kind: 'FAILURE'; failure: ComponentFailure };

export type TierFinalized =
  | { kind: 'OK'; text: string }
  | { kind: 'FAILURE'; failure: ComponentFailure };

export interface TierHandler {
  readonly tier: ModelTier;
  prepare(payload: ModelInvocationPayload, def: TierDefinition, ctx: TierPrepareContext): TierPrepared;
  finalize(rawText: string, constraints: TierConstraints, payload: ModelInvocationPayload): TierFinalized;
}

export type TierHandlerTable = Partial<Record<ModelTier, TierHandler>>;

/**
 * The default handler set. Empty at SPEC-151; each subsequent spec appends its
 * tier handler here (additive). Callers/tests may pass their own table instead.
 */
export function defaultTierHandlers(): TierHandlerTable {
  return {};
}

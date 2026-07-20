/**
 * Vendor-neutral model fabric (G16 / SPEC-151).
 *
 * The single entry point for every model call. Deterministic control flow:
 *
 *   validate identity+payload → resolve tier → tier handler.prepare
 *     ├─ RESOLVED (T0) → COMPLETED, no provider call            (SPEC-152)
 *     ├─ FAILURE       → typed rejection
 *     └─ INVOKE → resolve adapter → cost.authorize (INV-03)
 *                  → capability gate (SPEC-157) → attempt(s) with
 *                    timeout/quota (SPEC-158) and in-tier failover (SPEC-159)
 *                  → bound + finalize output → cost.settle → COMPLETED
 *
 * Invariants enforced here:
 *  - identity/tenant mandatory, fail-closed (INV-02, INV-05)
 *  - no provider call without a cost authorization port (INV-03)
 *  - unknown provider outcomes → UNKNOWN_OUTCOME, never blind retry (INV-06)
 *  - never silently escalate to a stronger/costlier tier
 *
 * SPEC-151 ships the core with a single-attempt invoke. Capability/quota/failover
 * are optional injected hooks that later specs wire in additively.
 */
import {
  REASON_CODES,
  completed,
  failure,
  type ComponentFailure,
  type ComponentResult,
} from '@/agent/contracts';
import { estimateTokens, type TokenUsage } from '@/agent/finops/tokens';
import {
  createAdapterResolver,
  type AdapterCall,
  type AdapterOutcome,
  type AdapterResolver,
  type ProviderAdapter,
} from '@/agent/providers/runtime/adapter';
import {
  CHARS_PER_TOKEN,
  MODEL_FABRIC_CONTRACT_VERSION,
  modelRequestSchema,
  type ModelInvocationValue,
  type ModelRequest,
  type ModelResult,
} from './contract';
import { MODEL_REASON_CODES } from './reason-codes';
import { TIER_DEFINITIONS, isModelTier } from './tiers';
import { createTierModelRegistry, type TierModelRegistry } from './registry';
import { defaultTierHandlers, type TierConstraints, type TierHandlerTable } from './tier-handler';
import { systemClock, type Clock, type CostAuthorizationPort } from './ports';

/** Optional extension hooks (wired by SPEC-157/158/159). */
export interface CapabilityGate {
  /** null = OK; string[] = unsupported capability reason codes */
  check(provider: string, model: string, required: string[]): string[] | null;
}
export interface AttemptRunner {
  /**
   * Run one provider invocation subject to timeout/quota (SPEC-158) and in-tier
   * failover across candidates (SPEC-159). Returns the outcome plus which
   * binding served it and how many attempts were made.
   */
  run(
    candidates: Array<{ provider: string; model: string }>,
    makeCall: (binding: { provider: string; model: string }) => AdapterCall,
    resolver: AdapterResolver,
  ): Promise<{ outcome: AdapterOutcome; provider: string; model: string; attempts: number } | { outcome: null; attempts: number; reasonCodes: string[] }>;
}

export interface ModelFabricDeps {
  cost: CostAuthorizationPort;
  adapters: ProviderAdapter[] | AdapterResolver;
  registry?: TierModelRegistry;
  handlers?: TierHandlerTable;
  clock?: Clock;
  capabilities?: CapabilityGate;
  attemptRunner?: AttemptRunner;
}

function resolverOf(a: ProviderAdapter[] | AdapterResolver): AdapterResolver {
  return Array.isArray(a) ? createAdapterResolver(a) : a;
}

function fail(status: Parameters<typeof failure>[0], codes: string[], opts?: { evidenceIds?: string[]; retryAfterMs?: number; approvalRequestId?: string }): ComponentFailure {
  // reasonCodes is string[]; fabric codes are plain strings alongside canonical ones
  return failure(status, codes as never, opts);
}

/** Map a provider AdapterOutcome error to a typed ComponentFailure. */
function mapProviderError(outcome: Exclude<AdapterOutcome, { kind: 'OK' }>): ComponentFailure {
  switch (outcome.kind) {
    case 'TIMEOUT':
      return fail('RETRYABLE', [MODEL_REASON_CODES.PROVIDER_TIMEOUT]);
    case 'RETRYABLE':
      return fail('RETRYABLE', [MODEL_REASON_CODES.PROVIDER_RETRYABLE]);
    case 'FINAL':
      return fail('FAILED_FINAL', [MODEL_REASON_CODES.PROVIDER_FINAL]);
    case 'UNKNOWN':
      // INV-06: unknown outcomes enter reconciliation, never blind retry
      return fail('UNKNOWN_OUTCOME', [REASON_CODES.UNKNOWN_OUTCOME]);
  }
}

export async function invokeModel(raw: unknown, deps: ModelFabricDeps): Promise<ModelResult> {
  // 1. validate envelope (identity + payload + contract version + size)
  const parsed = modelRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const codes = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (path === 'identity.tenantId') codes.add(REASON_CODES.MISSING_TENANT);
      else if (path === 'identity.actorId') codes.add(REASON_CODES.MISSING_ACTOR);
      else if (path === 'identity.workflowId') codes.add(REASON_CODES.MISSING_WORKFLOW);
      else if (path === 'identity.stepId') codes.add(REASON_CODES.MISSING_STEP);
      else if (path === 'identity.correlationId') codes.add(REASON_CODES.MISSING_CORRELATION);
      else codes.add(REASON_CODES.MALFORMED_INPUT);
    }
    return fail('FAILED_FINAL', [...codes]);
  }
  const request = parsed.data as ModelRequest;
  if (request.contractVersion !== MODEL_FABRIC_CONTRACT_VERSION) {
    return fail('FAILED_FINAL', [REASON_CODES.CONTRACT_VERSION_MISMATCH]);
  }

  const { payload, identity } = request;

  // 2. resolve tier
  if (!isModelTier(payload.tier)) return fail('FAILED_FINAL', [MODEL_REASON_CODES.TIER_UNKNOWN]);
  const def = TIER_DEFINITIONS[payload.tier];

  // 3. bound the input view (INV: bound input sizes)
  const maxInputChars = def.maxInputTokens * CHARS_PER_TOKEN;
  if (payload.prompt.length > maxInputChars) {
    return fail('FAILED_FINAL', [MODEL_REASON_CODES.INPUT_OVERSIZED]);
  }

  // 4. tier handler (fail closed if the tier is not implemented)
  const handlers = deps.handlers ?? defaultTierHandlers();
  const handler = handlers[payload.tier];
  if (!handler) return fail('FAILED_FINAL', [MODEL_REASON_CODES.TIER_NOT_IMPLEMENTED]);

  const registry: TierModelRegistry = deps.registry ?? createTierModelRegistry();
  const clock = deps.clock ?? systemClock;

  const prepared = handler.prepare(payload, def, { registry, clock, identity });
  if (prepared.kind === 'FAILURE') return prepared.failure;
  if (prepared.kind === 'RESOLVED') {
    // T0 — deterministic, no provider call
    return completed(prepared.value, evidenceForResolved(identity.correlationId), {
      fabric: MODEL_FABRIC_CONTRACT_VERSION,
      tier: payload.tier,
    });
  }

  // INVOKE — a provider call is required
  const constraints = prepared.constraints;
  const resolver = resolverOf(deps.adapters);

  // 5. capability gate (SPEC-157, optional until wired)
  if (deps.capabilities && payload.requiredCapabilities?.length) {
    const unsupported = deps.capabilities.check(constraints.provider, constraints.model, payload.requiredCapabilities);
    if (unsupported) return fail('FAILED_FINAL', [MODEL_REASON_CODES.CAPABILITY_UNSUPPORTED, ...unsupported]);
  }

  // adapter must exist for the primary binding (failover, if any, is checked in the runner)
  const primaryAdapter = resolver.resolve(constraints.provider);
  if (!primaryAdapter || !primaryAdapter.supports(constraints.model)) {
    return fail('FAILED_FINAL', [MODEL_REASON_CODES.ADAPTER_MISSING]);
  }

  // 6. cost pre-authorization (INV-03) — fail closed, never call a provider unauthorized
  const estInputTokens = estimateTokens(payload.prompt);
  const auth = await deps.cost.authorize({
    identity,
    tier: payload.tier,
    provider: constraints.provider,
    model: constraints.model,
    estInputTokens,
    estMaxOutputTokens: constraints.maxOutputTokens,
  });
  if (auth.status !== 'ALLOWED') {
    const status = auth.status === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'DENIED';
    return fail(status, auth.reasonCodes.length ? auth.reasonCodes : [MODEL_REASON_CODES.COST_NOT_AUTHORIZED], {
      evidenceIds: auth.evidenceIds,
    });
  }

  // 7. invoke (single attempt in SPEC-151; SPEC-159 failover via attemptRunner)
  const makeCall = (binding: { provider: string; model: string }): AdapterCall => ({
    provider: binding.provider,
    model: binding.model,
    prompt: payload.prompt,
    responseFormat: constraints.responseFormat,
    maxOutputTokens: constraints.maxOutputTokens,
    timeoutMs: constraints.timeoutMs,
    correlationId: identity.correlationId,
  });

  let outcome: AdapterOutcome;
  let servedProvider = constraints.provider;
  let servedModel = constraints.model;
  let attempts = 1;

  if (deps.attemptRunner) {
    const candidates = registry.candidates(payload.tier);
    const list = candidates.length ? candidates.map((c) => ({ provider: c.provider, model: c.model })) : [{ provider: constraints.provider, model: constraints.model }];
    const run = await deps.attemptRunner.run(list, makeCall, resolver);
    attempts = run.attempts;
    if (run.outcome === null) {
      await deps.cost.release(auth.authorizationId);
      return fail('RETRYABLE', run.reasonCodes.length ? run.reasonCodes : [MODEL_REASON_CODES.ALL_PROVIDERS_FAILED]);
    }
    outcome = run.outcome;
    servedProvider = run.provider;
    servedModel = run.model;
  } else {
    outcome = await primaryAdapter.invoke(makeCall({ provider: constraints.provider, model: constraints.model }));
  }

  if (outcome.kind !== 'OK') {
    await deps.cost.release(auth.authorizationId);
    return mapProviderError(outcome);
  }

  // 8. bound output (INV: bound output sizes)
  if (outcome.usage.outputTokens > constraints.maxOutputTokens) {
    await deps.cost.settle(auth.authorizationId, outcome.usage); // real spend still accounted
    return fail('FAILED_FINAL', [MODEL_REASON_CODES.OUTPUT_OVERSIZED]);
  }

  // 9. tier-specific finalize (shape/validate the raw text)
  const finalized = handler.finalize(outcome.text, { ...constraints, provider: servedProvider, model: servedModel }, payload);
  if (finalized.kind === 'FAILURE') {
    await deps.cost.settle(auth.authorizationId, outcome.usage);
    return finalized.failure;
  }

  // 10. settle actual cost + return
  await deps.cost.settle(auth.authorizationId, outcome.usage);
  const value: ModelInvocationValue = {
    tier: payload.tier,
    provider: servedProvider,
    model: servedModel,
    text: finalized.text,
    responseFormat: constraints.responseFormat,
    usage: outcome.usage,
    finishReason: outcome.finishReason,
    authorizationId: auth.authorizationId,
    attempts,
    deterministic: false,
  };
  return completed(value, evidenceForCall(identity.correlationId, servedProvider, servedModel, auth.evidenceIds), {
    fabric: MODEL_FABRIC_CONTRACT_VERSION,
    tier: payload.tier,
  });
}

function evidenceForResolved(correlationId: string): string[] {
  return [`model-t0:${correlationId}`];
}

function evidenceForCall(correlationId: string, provider: string, model: string, extra?: string[]): string[] {
  return [`model-call:${correlationId}`, `provider:${provider}/${model}`, ...(extra ?? [])];
}

export type { TierConstraints, TokenUsage };

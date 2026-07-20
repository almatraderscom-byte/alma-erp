/**
 * Provider capability discovery (G16 / SPEC-157).
 *
 * A deterministic, statically-declared table of what each provider model can do
 * (json mode, tools, vision, streaming, reasoning, context/output ceilings). The
 * fabric consults it BEFORE a call so a request that needs a capability the
 * chosen model lacks fails closed (`MODEL_CAPABILITY_UNSUPPORTED`) instead of
 * being sent to a provider that will reject or silently mis-handle it.
 *
 * "Discovery" here is a static declaration — NOT a live provider query. Querying
 * a provider's real capability endpoint at runtime is a documented seam; this
 * table is the deterministic source of truth used everywhere in the group.
 */
export const CAPABILITIES = ['json', 'tools', 'vision', 'streaming', 'reasoning'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ModelCapabilities {
  provider: string;
  model: string;
  json: boolean;
  tools: boolean;
  vision: boolean;
  streaming: boolean;
  reasoning: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** Statically-declared capabilities for the models the fabric can route to. */
export const CAPABILITY_REGISTRY: ModelCapabilities[] = [
  { provider: 'google', model: 'gemini-3.1-pro', json: true, tools: true, vision: true, streaming: true, reasoning: true, maxInputTokens: 1_000_000, maxOutputTokens: 65_536 },
  { provider: 'openrouter', model: 'or-deepseek-v4-flash', json: true, tools: true, vision: false, streaming: true, reasoning: false, maxInputTokens: 128_000, maxOutputTokens: 8_192 },
  { provider: 'openrouter', model: 'or-qwen3-max', json: true, tools: true, vision: false, streaming: true, reasoning: true, maxInputTokens: 256_000, maxOutputTokens: 32_768 },
  { provider: 'anthropic', model: 'claude-opus-4-8', json: true, tools: true, vision: true, streaming: true, reasoning: true, maxInputTokens: 200_000, maxOutputTokens: 64_000 },
];

/** Discover a model's declared capabilities, or null if unknown. */
export function discoverCapabilities(provider: string, model: string, registry: ModelCapabilities[] = CAPABILITY_REGISTRY): ModelCapabilities | null {
  return registry.find((c) => c.provider === provider && c.model === model) ?? null;
}

export function isCapability(x: unknown): x is Capability {
  return typeof x === 'string' && (CAPABILITIES as readonly string[]).includes(x);
}

/** True if the model declares support for a single capability. */
export function supportsCapability(caps: ModelCapabilities, required: string): boolean {
  if (!isCapability(required)) return false; // unknown capability → not supported (fail closed)
  return caps[required] === true;
}

/**
 * The fabric-facing capability gate: returns the list of unsupported capability
 * detail codes, or null when everything required is satisfied.
 */
export interface CapabilityGate {
  check(provider: string, model: string, required: string[]): string[] | null;
}

export function createCapabilityGate(registry: ModelCapabilities[] = CAPABILITY_REGISTRY): CapabilityGate {
  return {
    check(provider: string, model: string, required: string[]): string[] | null {
      const caps = discoverCapabilities(provider, model, registry);
      if (!caps) return [`UNKNOWN_MODEL:${provider}/${model}`];
      const missing = required.filter((r) => !supportsCapability(caps, r)).map((r) => `CAP:${r}`);
      return missing.length ? missing : null;
    },
  };
}

/**
 * Versioned provider pricing registry (G03 / SPEC-021).
 *
 * Single source of truth for what each provider charges. All money is integer
 * **nano-USD** (1e-9 USD) — no floats, no BDT. Exchange rates move daily, so the
 * ledger stays in real USD; any BDT display is a live display-time conversion,
 * never stored here (owner decision 2026-07).
 *
 * Prices are documented ESTIMATES until verified: every entry carries a `source`
 * and `effectiveDate` and `verified:false` until SPEC-030's freshness job
 * confirms it against the provider's published pricing.
 */
import { z } from 'zod';

export const NANO_PER_USD = 1_000_000_000;
export const usdToNano = (usd: number): number => Math.round(usd * NANO_PER_USD);
export const nanoToUsd = (nano: number): number => nano / NANO_PER_USD;

export type PricingUnit = 'per_mtok' | 'per_minute' | 'per_1k_char' | 'per_image';

export interface ProviderPrice {
  provider: string;
  model: string;
  version: number;
  unit: PricingUnit;
  // per_mtok fields — nano-USD per 1,000,000 tokens
  inputNanoUsdPerMTok?: number;
  cachedInputNanoUsdPerMTok?: number;
  outputNanoUsdPerMTok?: number;
  reasoningNanoUsdPerMTok?: number;
  // generic unit price for non-token providers (audio/tts/image)
  unitNanoUsd?: number;
  perToolCallNanoUsd?: number;
  source: string; // provider pricing doc URL / reference
  effectiveDate: string; // ISO date the estimate was recorded
  verified: boolean; // flipped true only after SPEC-030 verification
}

export const providerPriceSchema: z.ZodType<ProviderPrice> = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  version: z.number().int().positive(),
  unit: z.enum(['per_mtok', 'per_minute', 'per_1k_char', 'per_image']),
  inputNanoUsdPerMTok: z.number().int().nonnegative().optional(),
  cachedInputNanoUsdPerMTok: z.number().int().nonnegative().optional(),
  outputNanoUsdPerMTok: z.number().int().nonnegative().optional(),
  reasoningNanoUsdPerMTok: z.number().int().nonnegative().optional(),
  unitNanoUsd: z.number().int().nonnegative().optional(),
  perToolCallNanoUsd: z.number().int().nonnegative().optional(),
  source: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verified: z.boolean(),
}) as z.ZodType<ProviderPrice>;

const mtok = (usdPerMTok: number) => usdToNano(usdPerMTok);

/**
 * Seed prices — ESTIMATES (verified:false), effective 2026-07-20. Numbers are
 * documented approximations for planning; SPEC-030 must verify each against the
 * provider doc before it is treated as authoritative.
 */
export const PRICING_REGISTRY: ProviderPrice[] = [
  {
    provider: 'google', model: 'gemini-3.1-pro', version: 1, unit: 'per_mtok',
    inputNanoUsdPerMTok: mtok(2), cachedInputNanoUsdPerMTok: mtok(0.5), outputNanoUsdPerMTok: mtok(10), reasoningNanoUsdPerMTok: mtok(10),
    source: 'https://ai.google.dev/pricing (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'openrouter', model: 'or-deepseek-v4-flash', version: 1, unit: 'per_mtok',
    inputNanoUsdPerMTok: mtok(0.3), cachedInputNanoUsdPerMTok: mtok(0.1), outputNanoUsdPerMTok: mtok(1.2),
    source: 'https://openrouter.ai/models (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'openrouter', model: 'or-qwen3-max', version: 1, unit: 'per_mtok',
    inputNanoUsdPerMTok: mtok(1.2), cachedInputNanoUsdPerMTok: mtok(0.3), outputNanoUsdPerMTok: mtok(6),
    source: 'https://openrouter.ai/models (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'anthropic', model: 'claude-opus-4-8', version: 1, unit: 'per_mtok',
    inputNanoUsdPerMTok: mtok(15), cachedInputNanoUsdPerMTok: mtok(1.5), outputNanoUsdPerMTok: mtok(75), reasoningNanoUsdPerMTok: mtok(75),
    source: 'https://www.anthropic.com/pricing (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'openai', model: 'whisper-1', version: 1, unit: 'per_minute',
    unitNanoUsd: usdToNano(0.006),
    source: 'https://openai.com/pricing (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'google', model: 'tts-bn-IN-Chirp3-HD-Charon', version: 1, unit: 'per_1k_char',
    unitNanoUsd: usdToNano(0.016),
    source: 'https://cloud.google.com/text-to-speech/pricing (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
  {
    provider: 'google', model: 'nano-banana-pro', version: 1, unit: 'per_image',
    unitNanoUsd: usdToNano(0.04),
    source: 'https://ai.google.dev/pricing (estimate)', effectiveDate: '2026-07-20', verified: false,
  },
];

/** Get the highest-version price for a model (or a specific version). */
export function getPrice(provider: string, model: string, version?: number): ProviderPrice | null {
  const matches = PRICING_REGISTRY.filter((p) => p.provider === provider && p.model === model);
  if (matches.length === 0) return null;
  if (version !== undefined) return matches.find((p) => p.version === version) ?? null;
  return matches.reduce((a, b) => (b.version > a.version ? b : a));
}

/** Validate the whole registry (used by tests + freshness job). */
export function validateRegistry(registry: ProviderPrice[] = PRICING_REGISTRY): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of registry) {
    const parsed = providerPriceSchema.safeParse(p);
    if (!parsed.success) errors.push(`${p.provider}/${p.model}@v${p.version}: ${parsed.error.issues[0]?.message}`);
    const key = `${p.provider}/${p.model}@v${p.version}`;
    if (seen.has(key)) errors.push(`duplicate ${key}`);
    seen.add(key);
    if (p.unit === 'per_mtok' && p.inputNanoUsdPerMTok === undefined) errors.push(`${key}: per_mtok missing input price`);
    if (p.unit !== 'per_mtok' && p.unitNanoUsd === undefined) errors.push(`${key}: ${p.unit} missing unitNanoUsd`);
  }
  return { ok: errors.length === 0, errors };
}

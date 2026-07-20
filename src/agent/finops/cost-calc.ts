/**
 * Priced cost calculation with cached-input support (G03 / SPEC-023).
 *
 * Turns a token count + a ProviderPrice into an integer nano-USD cost. Cached
 * input tokens are billed at the (cheaper) cached rate; the rest of the input at
 * the normal input rate. All arithmetic is integer nano-USD — no floats, no BDT.
 * Deterministic and pure.
 */
import type { ProviderPrice } from '../providers/pricing/registry';

/** nano-USD cost of `tokens` at a per-million-token rate, rounded to integer. */
export function perMTokCost(tokens: number, nanoUsdPerMTok: number | undefined): number {
  if (!nanoUsdPerMTok || tokens <= 0) return 0;
  return Math.round((tokens * nanoUsdPerMTok) / 1_000_000);
}

export interface InputOutputTokens {
  inputTokens: number;
  cachedInputTokens?: number; // portion of inputTokens served from cache
  outputTokens: number;
}

export interface CostBreakdown {
  inputNanoUsd: number;
  cachedInputNanoUsd: number;
  outputNanoUsd: number;
  totalNanoUsd: number;
}

/**
 * Cost of input + cached-input + output for a per_mtok-priced model. Cached
 * tokens are subtracted from the billable input and charged at the cached rate.
 * Guards cachedInputTokens ≤ inputTokens.
 */
export function costForTokens(price: ProviderPrice, tokens: InputOutputTokens): CostBreakdown {
  if (price.unit !== 'per_mtok') {
    // Non-token providers are priced per unit elsewhere (ledger/media path).
    return { inputNanoUsd: 0, cachedInputNanoUsd: 0, outputNanoUsd: 0, totalNanoUsd: 0 };
  }
  const cached = Math.min(Math.max(0, tokens.cachedInputTokens ?? 0), Math.max(0, tokens.inputTokens));
  const billableInput = Math.max(0, tokens.inputTokens - cached);

  const inputNanoUsd = perMTokCost(billableInput, price.inputNanoUsdPerMTok);
  const cachedInputNanoUsd = perMTokCost(
    cached,
    // fall back to the full input rate if a cached rate isn't published
    price.cachedInputNanoUsdPerMTok ?? price.inputNanoUsdPerMTok,
  );
  const outputNanoUsd = perMTokCost(tokens.outputTokens, price.outputNanoUsdPerMTok);

  return {
    inputNanoUsd,
    cachedInputNanoUsd,
    outputNanoUsd,
    totalNanoUsd: inputNanoUsd + cachedInputNanoUsd + outputNanoUsd,
  };
}

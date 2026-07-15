import { OpenAiAdapter } from '@/agent/lib/models/adapters/openai'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

export function createOpenRouterAdapter(): OpenAiAdapter {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new Error('OPENROUTER_API_KEY not configured')
  const referer = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://alma-erp-six.vercel.app'
  return new OpenAiAdapter(key, {
    baseURL: OPENROUTER_BASE,
    defaultHeaders: {
      'HTTP-Referer': referer,
      'X-Title': 'ALMA ERP Agent',
    },
    // Cache the stable system-prompt prefix across turns (Qwen/DeepSeek/Claude via
    // OpenRouter). Big cost lever when a model runs as the direct head.
    cachePrefix: true,
    // Stream reasoning/thinking tokens so the UI shows DeepSeek's (and Qwen's, when
    // it reasons) live thinking block — the owner wants the same "thinking" feel the
    // DeepSeek/Claude apps show. Non-reasoning models simply emit nothing here.
    reasoning: true,
    // Ask OpenRouter for the ACTUAL billed cost per turn so the per-message cost
    // (and the Logs/Summary dashboards that read the same rows) match the
    // OpenRouter dashboard exactly, instead of a local token×rate estimate that
    // drifted 1.5–4× high (stale registry rates + guessed cache discounts).
    includeCostUsage: true,
    // Exacto quality routing + require_parameters on tool-bearing requests:
    // route only to hosts with proven tool-call parsers instead of the default
    // price-first "Balanced" pick (OpenRouter measured ~8%→~1% tool-call error
    // from this alone). Owner kill switches: ENABLE_OPENROUTER_EXACTO /
    // OPENROUTER_REQUIRE_PARAMETERS.
    exacto: true,
    requireParameters: true,
  })
}

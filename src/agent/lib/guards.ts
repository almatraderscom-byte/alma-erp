import { isAgentEnabled, isAnthropicConfigured } from '@/agent/config'
import { getModel, type Provider } from '@/agent/lib/models/registry'

/**
 * Call at the top of every /api/assistant/* route handler.
 * Returns a 503 Response when the agent is disabled, null otherwise.
 */
export function requireAgentEnabled(): Response | null {
  if (!isAgentEnabled()) {
    return new Response(JSON.stringify({ error: 'agent_disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

function isOpenAiConfigured(): boolean {
  const key = process.env.OPENAI_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

function isXaiConfigured(): boolean {
  const key = process.env.XAI_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

/** Returns 503 when the selected provider's API key is missing. */
export function requireProviderApiKey(provider: Provider): Response | null {
  if (provider === 'anthropic') return requireAnthropicApiKey()
  if (provider === 'openai' && !isOpenAiConfigured()) {
    return new Response(
      JSON.stringify({
        error: 'openai_key_missing',
        message: 'OPENAI_API_KEY is not set on the server.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (provider === 'google' && !isGeminiConfigured()) {
    return new Response(
      JSON.stringify({
        error: 'gemini_key_missing',
        message: 'GEMINI_API_KEY is not set on the server.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  if (provider === 'xai' && !isXaiConfigured()) {
    return new Response(
      JSON.stringify({
        error: 'xai_key_missing',
        message: 'XAI_API_KEY is not set on the server.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return null
}

/** Chat/tts/transcribe routes — returns 503 when Anthropic key is missing at runtime. */
export function requireAnthropicApiKey(): Response | null {
  if (!isAnthropicConfigured()) {
    return new Response(
      JSON.stringify({
        error: 'anthropic_key_missing',
        message: 'ANTHROPIC_API_KEY is not set on the server. Add it in Vercel → Production and redeploy.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return null
}

/** Validates owner-selected model and checks provider key. */
export function requireModelProviderKey(modelId?: string | null): Response | null {
  const model = getModel(modelId)
  return requireProviderApiKey(model.provider)
}

function isOpenRouterConfigured(): boolean {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

/**
 * Internal (worker/Telegram) chat calls used to hard-require the ANTHROPIC
 * key — a relic of the Claude-head era. The head is env-tunable (Luna today,
 * with DeepSeek/Qwen workers on OpenRouter and Gemini as the native
 * fallback), so the honest precondition is "at least one head-capable
 * provider is configured", not one specific vendor (owner ruling 2026-08-25:
 * the self-hosted engine must not demand an Anthropic key it never uses).
 * A concrete model choice still gets its exact provider checked downstream
 * by requireModelProviderKey / the head router.
 */
export function requireAnyHeadProviderKey(): Response | null {
  if (
    isOpenAiConfigured()
    || isOpenRouterConfigured()
    || isGeminiConfigured()
    || isAnthropicConfigured()
    || isXaiConfigured()
  ) return null
  return new Response(
    JSON.stringify({
      error: 'no_head_provider_key',
      message: 'No model-provider API key is configured (OPENAI/OPENROUTER/GEMINI/ANTHROPIC/XAI). Add at least one to the server env.',
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  )
}

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
  if (provider === 'openrouter' && !isOpenRouterConfigured()) {
    // Codex P1 #854: this branch was missing, so an OpenRouter-headed
    // internal call passed preflight and died in createOpenRouterAdapter().
    return new Response(
      JSON.stringify({
        error: 'openrouter_key_missing',
        message: 'OPENROUTER_API_KEY is not set on the server.',
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

/** Boolean view of requireProviderApiKey, for in-turn fallback decisions. */
export function isProviderKeyConfigured(provider: Provider): boolean {
  return requireProviderApiKey(provider) === null
}

function isOpenRouterConfigured(): boolean {
  const key = process.env.OPENROUTER_API_KEY?.trim()
  return Boolean(key && key.length >= 20 && !/^REPLACE_|YOUR_/i.test(key))
}

/**
 * Internal (worker/Telegram) chat calls used to hard-require the ANTHROPIC
 * key — a relic of the Claude-head era. The head is env-tunable (Luna today,
 * with DeepSeek/Qwen workers on OpenRouter and Gemini as the native
 * fallback), so the honest precondition is "the provider the DEFAULT head
 * will actually run on is configured" (owner ruling 2026-08-25: the
 * self-hosted engine must not demand an Anthropic key it never uses; Codex
 * P1 #854: an any-key check would admit a box whose only key belongs to a
 * provider the default head never touches, and the turn would then die in
 * the adapter instead of 503ing honestly here). A conversation-pinned model
 * still gets its exact provider checked downstream by
 * requireModelProviderKey / the head router's fallbacks.
 */
export async function requireDefaultHeadProviderKey(
  /** The default-head id the caller ALREADY resolved for this request — pass
   * it so the guard validates the exact model the request will run instead of
   * doing a second KV read that can race an in-flight owner switch (Codex P2
   * #854). */
  resolvedDefaultHeadModelId?: string,
): Promise<Response | null> {
  try {
    if (resolvedDefaultHeadModelId) {
      return requireModelProviderKey(resolvedDefaultHeadModelId)
    }
    const { getDefaultHeadModelId } = await import('@/agent/lib/models/routing-config')
    return requireModelProviderKey(await getDefaultHeadModelId())
  } catch {
    // KV/registry glitch must not take the whole internal lane down: fall
    // back to "at least one head-capable provider exists".
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
}

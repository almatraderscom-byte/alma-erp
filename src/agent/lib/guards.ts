import { isAgentEnabled, isAnthropicConfigured } from '@/agent/config'

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

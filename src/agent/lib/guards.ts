import { isAgentEnabled } from '@/agent/config'

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

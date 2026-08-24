export type AgentReferenceRollout = 'off' | 'shadow' | 'on'
export type AgentReferenceEnv = {
  [key: string]: string | undefined
  AGENT_REFERENCES_ROLLOUT?: string
  AGENT_REFERENCES_KILL_SWITCH?: string
}

function rollout(value: string | undefined): AgentReferenceRollout {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'on' || normalized === 'enabled' || normalized === 'true' || normalized === '1') return 'on'
  if (normalized === 'shadow') return 'shadow'
  return 'off'
}

/**
 * Server-side rollout. `shadow` extracts, validates and persists references but
 * leaves visible Markdown unchanged. The emergency kill switch wins over every
 * other setting and needs no deploy-time data migration.
 */
export function agentReferenceRollout(env: AgentReferenceEnv = process.env): AgentReferenceRollout {
  const killed = env.AGENT_REFERENCES_KILL_SWITCH?.trim().toLowerCase()
  if (killed === '1' || killed === 'true' || killed === 'on' || killed === 'enabled') return 'off'
  return rollout(env.AGENT_REFERENCES_ROLLOUT ?? 'shadow')
}

export function shouldCollectAgentReferences(env: AgentReferenceEnv = process.env): boolean {
  return agentReferenceRollout(env) !== 'off'
}

export function shouldRenderAgentReferences(env: AgentReferenceEnv = process.env): boolean {
  return agentReferenceRollout(env) === 'on'
}

/** Metadata may remain durable in shadow mode, but clients must not receive it. */
export function exposedAgentReferences<T>(
  values: ReadonlyArray<T>,
  env: AgentReferenceEnv = process.env,
): T[] {
  return shouldRenderAgentReferences(env) ? [...values] : []
}

/** Keep shadow metadata server-side; providers must not echo hidden destinations. */
export function toolResultForReferenceRollout<T extends object>(
  value: T,
  env: AgentReferenceEnv = process.env,
): T {
  const record = value as Record<string, unknown>
  if (shouldRenderAgentReferences(env) || !Object.prototype.hasOwnProperty.call(record, 'references')) return value
  const { references: _hiddenReferences, ...visible } = record
  return visible as T
}

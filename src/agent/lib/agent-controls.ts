/**
 * Owner "Control Center" switches for the whole agent.
 *
 * Stored as one JSON blob in the existing `AgentKvSetting` table (key
 * `agent_controls`) — no migration needed. Every read FAILS OPEN: if the store
 * is unreachable or malformed, the agent behaves normally (never silently
 * bricked by a settings glitch). Only an explicit `true`/`false` from the owner
 * changes behavior.
 */
import { prisma } from '@/lib/prisma'

export const AGENT_CONTROLS_KV_KEY = 'agent_controls'

export interface AgentControls {
  /** Master pause — stops the agent from replying/acting (web + Telegram). */
  paused: boolean
}

export const DEFAULT_AGENT_CONTROLS: AgentControls = {
  paused: false,
}

export function parseAgentControls(value: string | null | undefined): AgentControls {
  if (!value) return { ...DEFAULT_AGENT_CONTROLS }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_AGENT_CONTROLS }
    }
    return { ...DEFAULT_AGENT_CONTROLS, ...(parsed as Partial<AgentControls>) }
  } catch {
    return { ...DEFAULT_AGENT_CONTROLS }
  }
}

export async function getAgentControls(): Promise<AgentControls> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: AGENT_CONTROLS_KV_KEY } })
    return parseAgentControls(row?.value)
  } catch {
    // Fail open — a storage hiccup must never block the live agent.
    return { ...DEFAULT_AGENT_CONTROLS }
  }
}

export async function setAgentControls(patch: Partial<AgentControls>): Promise<AgentControls> {
  const current = await getAgentControls()
  const next: AgentControls = { ...current, ...patch }
  await prisma.agentKvSetting.upsert({
    where: { key: AGENT_CONTROLS_KV_KEY },
    create: { key: AGENT_CONTROLS_KV_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  })
  return next
}

export async function isAgentPaused(): Promise<boolean> {
  return (await getAgentControls()).paused === true
}

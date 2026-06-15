/**
 * Agent business context resolver — Phase 7.
 *
 * The agent module supports two business scopes:
 *   - ALMA_LIFESTYLE (default / Lifestyle ops)
 *   - ALMA_TRADING   (Binance P2P trading)
 *
 * `businessId` is stored on AgentProject + AgentConversation. Resolution order:
 *   1. Explicit override (e.g. internal callers)
 *   2. conversation.businessId
 *   3. conversation.project.businessId
 *   4. project.businessId (when only projectId provided)
 *   5. null  → callers default to ALMA_LIFESTYLE for safety
 *
 * Personal-mode conversations stay null (cross-business / personal).
 */
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_BUSINESS_ID } from '@/lib/agent-api/constants'

export type AgentBusinessId = 'ALMA_LIFESTYLE' | 'ALMA_TRADING'

export const AGENT_BUSINESS_IDS: AgentBusinessId[] = ['ALMA_LIFESTYLE', 'ALMA_TRADING']

export function isAgentBusinessId(value: unknown): value is AgentBusinessId {
  return value === 'ALMA_LIFESTYLE' || value === 'ALMA_TRADING'
}

export function normalizeBusinessId(value: unknown): AgentBusinessId {
  return isAgentBusinessId(value) ? value : (DEFAULT_AGENT_BUSINESS_ID as AgentBusinessId)
}

export async function resolveBusinessIdForConversation(
  conversationId: string | null | undefined,
): Promise<AgentBusinessId | null> {
  if (!conversationId) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: {
      businessId: true,
      project: { select: { businessId: true } },
    },
  })
  if (!conv) return null
  if (isAgentBusinessId(conv.businessId)) return conv.businessId
  if (isAgentBusinessId(conv.project?.businessId)) return conv.project!.businessId as AgentBusinessId
  return null
}

export async function resolveBusinessIdForProject(
  projectId: string | null | undefined,
): Promise<AgentBusinessId | null> {
  if (!projectId) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const proj = await db.agentProject.findUnique({
    where: { id: projectId },
    select: { businessId: true },
  })
  if (!proj) return null
  return isAgentBusinessId(proj.businessId) ? proj.businessId : null
}

/**
 * Inherit businessId from project when a new conversation is created.
 * Returns the businessId to stamp on AgentConversation.
 */
export async function inheritConversationBusinessId(
  projectId: string | null | undefined,
): Promise<AgentBusinessId | null> {
  return resolveBusinessIdForProject(projectId)
}

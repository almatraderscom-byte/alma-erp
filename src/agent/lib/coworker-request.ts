/**
 * Read→write bridge for the external Claude co-worker.
 *
 * The MCP connector is read-only by design — the co-worker can look but never act. This
 * module is the ONE controlled exception: the co-worker can FILE A PROPOSAL (via the
 * `request_agent_action` connector tool) for the owner's internal agent to do something.
 * It executes nothing on its own — it just creates a `coworker_request` row in
 * `agent_pending_actions` (status='pending'), which:
 *   1. the unified follow-up engine surfaces + chases on the owner (pending-followup.ts), and
 *   2. on the owner's approval, the head executes with its normal business tools
 *      (processCoworkerRequestReply below hands it the request + an EXECUTE instruction).
 *
 * So the safety model is preserved: co-worker proposes → owner approves → internal agent acts.
 * The connector still moves no money, touches no business data directly — it only files a
 * request that REQUIRES the owner's yes.
 */
import { prisma } from '@/lib/prisma'

export const COWORKER_REQUEST_TYPE = 'coworker_request'
const BUSINESS_ID = 'ALMA_LIFESTYLE'
/** Owner can act on a surfaced request within this window; older ones aren't auto-approved. */
const DECISION_WINDOW_MS = 6 * 60 * 60 * 1000

export type CoworkerRequestInput = {
  summary: string
  details?: string
  category?: string
  urgency?: 'low' | 'normal' | 'high'
}

export async function fileCoworkerRequest(input: CoworkerRequestInput): Promise<{ id: string }> {
  const summary = (input.summary ?? '').trim()
  if (!summary) throw new Error('summary required')
  const row = await prisma.agentPendingAction.create({
    data: {
      type: COWORKER_REQUEST_TYPE,
      status: 'pending',
      businessId: BUSINESS_ID,
      summary: `Claude co-worker চাইছে: ${summary}`,
      payload: {
        source: 'claude_coworker',
        request: summary,
        details: input.details ?? null,
        category: input.category ?? 'other',
        urgency: input.urgency ?? 'normal',
        requestedAt: new Date().toISOString(),
      },
    },
    select: { id: true },
  })
  return { id: row.id }
}

type OpenRequest = { id: string; summary: string; payload: unknown; createdAt: Date }

export async function listOpenCoworkerRequests(): Promise<OpenRequest[]> {
  return prisma.agentPendingAction.findMany({
    where: { type: COWORKER_REQUEST_TYPE, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, summary: true, payload: true, createdAt: true },
  })
}

// NOTE: \b doesn't form boundaries around Bangla (non-ASCII) — latin parts use lookarounds,
// Bangla parts are plain alternations.
const APPROVE_PATTERN =
  /(?<![a-z])(approve|approved|accept|yes|okay|ok|sure|raji|confirm|hae|han|ha)(?![a-z])|করে\s*দাও|করে\s*ফেল|kore\s*dao|kore\s*felo|রাজি|নিশ্চিত|হ্যাঁ|হ্যা/i
const REJECT_PATTERN =
  /(?<![a-z])(reject|cancel|no|nah|batil|thak)(?![a-z])|বাদ\s*দাও|bad\s*dao|বাতিল|লাগবে\s*না|lagbe\s*na|থাক|না,/i

export type CoworkerReplyResult = { autoReply?: string; contextBlock?: string }

/**
 * Capture the owner's approve/reject decision on a pending co-worker request. Only fires when
 * such a request is pending AND was filed recently (the owner has been chased about it), so it
 * never hijacks unrelated chat. Approve → hand the head the request + EXECUTE instruction.
 */
export async function processCoworkerRequestReply(
  text: string,
  _conversationId?: string,
): Promise<CoworkerReplyResult | null> {
  const trimmed = text.trim()
  if (!trimmed) return null

  const open = await listOpenCoworkerRequests()
  if (open.length === 0) return null
  const recent = open.filter((r) => Date.now() - new Date(r.createdAt).getTime() < DECISION_WINDOW_MS)
  if (recent.length === 0) return null

  const reject = REJECT_PATTERN.test(trimmed)
  const approve = !reject && APPROVE_PATTERN.test(trimmed)
  if (!approve && !reject) return null

  const ids = recent.map((r) => r.id)

  if (reject) {
    await prisma.agentPendingAction.updateMany({
      where: { id: { in: ids } },
      data: { status: 'rejected', resolvedAt: new Date() },
    })
    return { autoReply: `ঠিক আছে Sir, Claude co-worker-এর ${ids.length}টি অনুরোধ বাদ দিলাম।` }
  }

  // Approve: mark out of pending (stops the chase) and hand the head an execute instruction.
  await prisma.agentPendingAction.updateMany({
    where: { id: { in: ids } },
    data: { status: 'approved', resolvedAt: new Date() },
  })
  const lines = recent
    .map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>
      const req = (p.request as string) ?? r.summary
      const details = p.details ? ` — ${String(p.details)}` : ''
      return `• ${req}${details}`
    })
    .join('\n')
  return {
    contextBlock:
      `[CO-WORKER REQUEST APPROVED — EXECUTE NOW]\n` +
      `Sir approved ${ids.length} request(s) from the external Claude co-worker:\n${lines}\n` +
      `Carry these out NOW using your normal business tools (orders / inventory / marketing / staff / finance / content as relevant). ` +
      `Verify each step before claiming done. They are already marked approved — do NOT create a new approval card. ` +
      `Reply in Bangla, concise, confirming exactly what you did.`,
  }
}

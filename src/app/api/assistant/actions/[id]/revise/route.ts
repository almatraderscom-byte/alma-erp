import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { isRevisableAction, buildReviseDirective } from '@/agent/lib/revise-pending'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import type { AgentEvent } from '@/agent/lib/core'
import type { AgentBusinessId } from '@/lib/agent-api/business-context'

export const runtime = 'nodejs'
// The revise runs one full head turn (edit tools + verification). On a cold start
// with Gemini latency this can exceed 60s → Vercel 504, so match the approve cap.
export const maxDuration = 120

// A single head turn is enough for an in-place card edit; cap the wall clock so a
// stuck tool loop can't hold the request past maxDuration.
const REVISE_MAX_TURN_MS = 110_000
const FEEDBACK_MIN_LEN = 2
const FEEDBACK_MAX_LEN = 2000

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Owner typed his opinion on a pending card instead of Approve/Reject. Persist it
 * as an owner turn and run one scoped head turn: the head re-edits THIS card in
 * place with its own edit tools and confirms. The card stays pending for a final
 * Approve. See `revise-pending.ts` for why the rewrite is not done here.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { feedback?: unknown }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
  if (feedback.length < FEEDBACK_MIN_LEN) {
    return Response.json({ error: 'feedback_required', message: 'মতামত লিখুন।' }, { status: 400 })
  }
  if (feedback.length > FEEDBACK_MAX_LEN) {
    return Response.json({ error: 'feedback_too_long' }, { status: 400 })
  }

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }
  if (isPendingActionExpired(action.createdAt, action.type)) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    return Response.json({ error: 'expired', message: 'অনুমোদনের সময় শেষ।' }, { status: 410 })
  }
  if (!isRevisableAction(action.type)) {
    return Response.json(
      { error: 'not_revisable', message: 'এই কার্ডে মতামত দিয়ে রিভাইজ করা যায় না — Approve বা Reject করুন।' },
      { status: 400 },
    )
  }

  const rawConvId = action.conversationId ?? (action.payload as Record<string, unknown>)?.conversationId
  let conversationId = typeof rawConvId === 'string' && rawConvId.trim() ? rawConvId.trim() : null
  if (!conversationId) {
    // Cron-born cards (evening dispatch proposal, duty digests) legitimately have
    // no chat conversation — but the owner's opinion must still reach the head.
    // The old 409 here surfaced in every client as the WRONG error ("এই অ্যাকশনটি
    // ইতিমধ্যে সম্পন্ন হয়েছে" — clients map all 409s to already-resolved; owner bug
    // 2026-07-12). Home the revise turn in the day-shift conversation instead and
    // link the card to it so follow-up opinions land in the same thread.
    try {
      const { getOrCreateDayShiftConversation } = await import('@/agent/lib/day-shift')
      conversationId = await getOrCreateDayShiftConversation()
      await db.agentPendingAction.update({
        where: { id: actionId },
        data: { conversationId },
      })
    } catch (err) {
      console.error('[revise] day-shift conversation fallback failed:', err instanceof Error ? err.message : err)
      return Response.json(
        { error: 'no_conversation', message: 'রিভাইজ চালানোর মতো চ্যাট তৈরি করা যায়নি — একটু পরে আবার চেষ্টা করুন।' },
        { status: 503 },
      )
    }
  }

  const businessId = (action.businessId as AgentBusinessId) ?? ('ALMA_LIFESTYLE' as AgentBusinessId)

  // Phase 1 approval span: a revision carries the owner's correction TEXT — the
  // roadmap's "link approval-card revision feedback to the originating tool call".
  // The span joins this card + feedback into the conversation trace (fail-open).
  void import('@/agent/lib/tool-telemetry').then((m) =>
    m.logToolEvent({
      toolName: '__approval__',
      phase: 'approval',
      success: true,
      conversationId,
      businessId,
      detail: { actionId, actionType: action.type, decision: 'revised', feedback: feedback.slice(0, 500) },
    }),
  ).catch(() => {})

  // Persist Boss's opinion as an owner turn so the head picks it up as the latest
  // message (and it leaves an auditable trail in the conversation).
  await db.agentMessage.create({
    data: {
      conversationId,
      role: 'user',
      content: [{ type: 'text', text: buildReviseDirective({
        id: actionId,
        type: String(action.type),
        summary: String(action.summary ?? ''),
        feedback,
      }) }],
    },
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REVISE_MAX_TURN_MS)

  let reply = ''
  let costUsd = 0
  let error: string | undefined

  try {
    const stream: AsyncGenerator<AgentEvent> = runOwnerTurn(conversationId, {
      businessId,
      signal: controller.signal,
    })
    for await (const ev of stream) {
      switch (ev.type) {
        case 'text_delta':
          reply += ev.delta
          break
        case 'verification_retry':
          // Head retried after an unverified claim — drop the partial, mirror chat.
          reply = ''
          break
        case 'error':
          error = ev.message
          break
        case 'done':
          costUsd = ev.costUsd ?? 0
          break
        default:
          break
      }
    }
  } catch (err) {
    error = controller.signal.aborted
      ? 'রিভাইজে সময় বেশি লাগছে — একটু পরে আবার চেষ্টা করুন।'
      : (err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }

  if (error && !reply.trim()) {
    return Response.json({ error: 'revise_failed', message: error }, { status: 502 })
  }

  // Re-read the card: the head may have edited it in place (stays pending) or
  // superseded it with a fresh card. Either way the client should refresh its list;
  // we return the current state of the original id as a convenience.
  const after = await db.agentPendingAction.findUnique({
    where: { id: actionId },
    select: { id: true, type: true, summary: true, status: true },
  })

  return Response.json({
    success: true,
    reply: reply.trim() || 'ঠিক আছে Boss, মতামত অনুযায়ী কার্ডটা আপডেট করেছি।',
    costUsd,
    action: after
      ? { id: after.id, type: after.type, summary: after.summary, status: after.status }
      : null,
  })
}

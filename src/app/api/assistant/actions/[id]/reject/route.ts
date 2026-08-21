import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { randomUUID, timingSafeEqual } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'
import { recordRejection } from '@/agent/lib/trust-engine'
import { getModel, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import {
  completeRejectedDelegationPlanStepsInTransaction,
  reconcilePlanTrackersForPendingAction,
  settlePlanStepsLinkedToPendingAction,
  settleRejectedPlanStepsInTransaction,
} from '@/agent/lib/planner'

export const runtime = 'nodejs'
// A rejected delegation makes the Sonnet head answer the task itself (one
// completion). On a cold start + Anthropic latency this can exceed 60s and
// return a Vercel 504 ("HTTP error" toast), so match the approve route's cap.
export const maxDuration = 120

/**
 * Owner chose "Sonnet বলুক" on a delegation card → run the head model directly
 * on the original task and return its Bangla answer (no tools, single turn).
 */
async function runHeadDirectAnswer(task: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const model = getModel(DEFAULT_MODEL_ID)
  const system =
    'তুমি ALMA-র হেড অ্যাসিস্ট্যান্ট (Sonnet)। মালিক worker-কে কাজটা না দিয়ে চেয়েছেন তুমি নিজে উত্তর দাও। ' +
    'নিচের কাজটির জন্য সরাসরি, ব্যবহারিক, তথ্যবহুল বাংলা উত্তর দাও — মালিককে "Boss" বলে সম্বোধন করো। ' +
    'অপ্রয়োজনীয় ভূমিকা নয়, ইসলামিক গাইডরেল মেনে চলো।'
  const resp = await client.messages.create({
    model: model.apiModel,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: task }],
  })
  const text = resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  return { text, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens }
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.warn('[reject] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const DELEGATION_FALLBACK_MESSAGE_ID = 'delegationFallbackMessageId'
const DELEGATION_FALLBACK_FAILED = 'delegationFallbackFailed'
const DELEGATION_FALLBACK_CLAIM_ID = 'delegationFallbackClaimId'
const DELEGATION_FALLBACK_CLAIMED_AT = 'delegationFallbackClaimedAt'
const DELEGATION_FALLBACK_LEASE_MS = 3 * 60_000

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const actionId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: actionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  const priorResult = jsonRecord(action.result)
  const fallbackMessageId = typeof priorResult[DELEGATION_FALLBACK_MESSAGE_ID] === 'string'
    ? String(priorResult[DELEGATION_FALLBACK_MESSAGE_ID])
    : null
  const fallbackFailed = priorResult[DELEGATION_FALLBACK_FAILED] === true
  const retryingRejectedDelegation = action.status === 'rejected'
    && action.type === 'delegation'
    && !fallbackMessageId
    && !fallbackFailed
  if (action.status !== 'pending' && !retryingRejectedDelegation) {
    // The action claim and linked plan-row settlement are separate durable
    // writes. A retry after a transient settlement failure must repair the row
    // before reporting that this rejection was already resolved.
    if (['executed', 'failed', 'rejected', 'expired', 'cancelled', 'superseded'].includes(action.status)) {
      await settlePlanStepsLinkedToPendingAction(actionId)
      await reconcilePlanTrackersForPendingAction(actionId)
    }
    if (action.status === 'rejected' && action.type === 'delegation' && fallbackMessageId) {
      return Response.json({
        success: true,
        status: 'rejected',
        answered: true,
        assistantMessageId: fallbackMessageId,
        replayed: true,
      })
    }
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }

  if (!retryingRejectedDelegation && isPendingActionExpired(action.createdAt, action.type)) {
    await db.agentPendingAction.update({
      where: { id: actionId },
      data: { status: 'expired', resolvedAt: new Date() },
    })
    await settlePlanStepsLinkedToPendingAction(actionId)
    await reconcilePlanTrackersForPendingAction(actionId)
    return Response.json({ error: 'expired', message: 'অনুমোদনের সময় শেষ — ৩০ মিনিটের মধ্যে সিদ্ধান্ত নিতে হবে।' }, { status: 410 })
  }

  // Claim CONDITIONALLY on the row still being pending. The status read above
  // happened before this write, so an approve landing in between would already
  // have executed — an unconditional update would then stamp `rejected` over it
  // and report success while, for a permission card, the grant kept running
  // (review bot, #667).
  // media_plan: the card claim and the project cancellation must land TOGETHER —
  // a crash after a lone claim would leave a rejected card on a 'planned'
  // project with no retry path (retries 409 already_resolved). Same claim
  // semantics as the generic path, plus the CAS-guarded project settle.
  const mediaProjectId =
    action.type === 'media_plan' &&
    typeof (action.payload as { projectId?: unknown } | null)?.projectId === 'string'
      ? String((action.payload as { projectId: string }).projectId)
      : null
  const rejectedCount = retryingRejectedDelegation ? 1 : (await db.$transaction(async (tx: typeof db) => {
    // Serialize with linkPendingActionToPlanStep's payload ownership write.
    // Otherwise a just-rendered card could be rejected between its row link and
    // payload update, committing only one side of the tracker contract.
    const lockKey = `pending-action-plan:${actionId}`
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS lock_token`
    const rejected = await tx.agentPendingAction.updateMany({
      where: { id: actionId, status: 'pending' },
      // ownerDecided: rejection is always his — nothing in this system auto-rejects.
      data: { status: 'rejected', resolvedAt: new Date(), ownerDecided: true },
    })
    if (rejected.count > 0 && mediaProjectId) {
      await tx.agentMediaProject.updateMany({
        // CAS on pendingActionId: only THIS card may cancel the project — a
        // fresh revision card (which swapped pendingActionId) stays alive.
        where: { id: mediaProjectId, status: { in: ['draft', 'planned'] }, pendingActionId: actionId },
        data: { status: 'cancelled' },
      })
    }
    // A delegation rejection is not a task failure: its linked row completes
    // only in the later transaction that durably stores the head-model answer.
    if (rejected.count > 0 && action.type !== 'delegation') {
      const rejectedAction = await tx.agentPendingAction.findUnique({
        where: { id: actionId },
        select: { id: true, type: true, payload: true, result: true },
      })
      if (!rejectedAction) throw new Error('rejected_action_missing_after_claim')
      await settleRejectedPlanStepsInTransaction(tx, rejectedAction)
    }
    return rejected.count
  })) as number
  if (rejectedCount === 0) {
    const now = await db.agentPendingAction.findUnique({ where: { id: actionId }, select: { status: true } })
    return Response.json({ error: 'already_resolved', status: now?.status }, { status: 409 })
  }
  // Rows were atomically terminalized with the action above. This idempotent
  // pass projects the new durable state into tracker snapshots/live surfaces;
  // a projection failure cannot strand execution truth.
  if (action.type !== 'delegation') {
    await settlePlanStepsLinkedToPendingAction(actionId)
    await reconcilePlanTrackersForPendingAction(actionId)
  }
  const { pushCurrentPulseLiveActivity } = await import('@/agent/lib/pulse-live-update')
  await pushCurrentPulseLiveActivity()

  // Phase 4 sync: a rejected card cancels its canonical WorkflowRun and the
  // terminal transition auto-closes the linked open-task chips. Fail-open.
  try {
    const { syncWorkflowWithPendingAction } = await import('@/agent/lib/workflow-run')
    await syncWorkflowWithPendingAction(actionId, 'approval')
  } catch (err) {
    console.warn('[reject] workflow sync failed (rejection unaffected):', err instanceof Error ? err.message : err)
  }

  // Phase 34: consume the card's bridge/interrupt thread (typed 'reject') so a
  // later stray approve on the same thread reports already-consumed instead of
  // resuming. Zero effects either way — rejection is final. Fail-open.
  try {
    const bridgeThread = (action.payload as { bridgeThread?: { threadId?: string }; graphThread?: { threadId?: string } })
    if (bridgeThread.bridgeThread?.threadId) {
      const { resumeDecisionThread } = await import('@/agent/lib/graph/action-bridge')
      await resumeDecisionThread({ decision: 'reject', cardId: actionId })
    }
  } catch (err) {
    console.warn('[reject] bridge thread consume failed (rejection unaffected):', err instanceof Error ? err.message : err)
  }

  // Phase 1 approval span: rejections join the turn trace too — a rejected card
  // is the strongest "the agent staged the wrong thing" signal we have (fail-open).
  void import('@/agent/lib/tool-telemetry').then((m) =>
    m.logToolEvent({
      toolName: '__approval__',
      phase: 'approval',
      success: true,
      conversationId: (action.conversationId as string | null) ?? null,
      businessId: (action.businessId as string) ?? 'ALMA_LIFESTYLE',
      detail: { actionId, actionType: action.type, decision: 'rejected' },
    }),
  ).catch(() => {})

  // Record trust rejection (non-blocking)
  const trustDomain = (action.type as string).startsWith('staff_') ? 'staff' :
    ['content_gate1', 'content_gate2', 'fb_post', 'instagram_post', 'ad_creative_gate', 'ads_creative_brief', 'reply_to_comment', 'launch_campaign'].includes(action.type as string) ? 'content' :
    (action.type as string).startsWith('website_') ? 'content' :
    (action.type as string).startsWith('log_') || action.type === 'delete_finance_entry' || action.type === 'edit_finance_entry' ? 'finance' :
    'general'
  const trustBiz = (action.businessId as string) ?? 'ALMA_LIFESTYLE'
  // A rejected delegation is NOT a rejection of the work — the owner just chose
  // Sonnet over the worker. Don't pollute the trust engine with it.
  if (action.type !== 'delegation') {
    void recordRejection(trustDomain, action.type as string, trustBiz).catch((err) => {
      console.warn('[reject] recordRejection failed:', err instanceof Error ? err.message : err)
    })
  }

  const payload = action.payload as Record<string, unknown>

  // Media mode: the project was already cancelled atomically with the claim
  // above — this branch only shapes the response.
  if (action.type === 'media_plan') {
    return Response.json({ success: true, status: 'rejected', projectCancelled: Boolean(mediaProjectId) })
  }

  // Office-absence ❌ না: owner did NOT send anyone out → ask WHICH staffer is
  // missing so the chosen one gets the camera frame + a nudge.
  if (action.type === 'office_absence_confirm') {
    const p = payload as { photoUrl?: string; deviceId?: string }
    const { sendAbsenceStaffPicker } = await import('@/agent/lib/office-absence')
    const res = await sendAbsenceStaffPicker({
      photoUrl: String(p.photoUrl ?? ''),
      deviceId: String(p.deviceId ?? ''),
    })
    return Response.json({ success: true, status: 'rejected', askedWhichStaff: res.ok })
  }

  // ❌ বাতিল on the staff-nudge preview → owner changed his mind; the staffer is
  // NEVER messaged. Just acknowledge to the owner. (Row already marked rejected above.)
  if (action.type === 'office_absence_nudge_send') {
    const p = payload as { staffName?: string }
    try {
      const { sendOwnerText } = await import('@/agent/lib/telegram-owner-notify')
      await sendOwnerText(`🚫 ঠিক আছে Boss — ${p.staffName ?? 'স্টাফ'}-কে কোনো মেসেজ পাঠানো হয়নি, বাতিল করা হলো।`)
    } catch (err) {
      console.warn('[reject] nudge-send cancel notice failed:', err instanceof Error ? err.message : err)
    }
    return Response.json({ success: true, status: 'rejected', cancelled: true })
  }

  // Delegation rejected → the owner wants Sonnet to answer the task itself.
  if (action.type === 'delegation') {
    const task = String(payload.task ?? '').trim()
    const rawConvId = action.conversationId ?? payload.conversationId
    const conversationId = typeof rawConvId === 'string' && rawConvId.trim() ? rawConvId.trim() : null
    // Rejecting the card and generating the head answer are necessarily two
    // transactions. Lease the second phase before the provider call so two
    // HTTP retries cannot both spend/generate, or race success against failure.
    const claimId = randomUUID()
    const claim = await db.$transaction(async (tx: typeof db) => {
      const lockKey = `pending-action-plan:${actionId}`
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS lock_token`
      const current = await tx.agentPendingAction.findUnique({
        where: { id: actionId },
        select: { status: true, type: true, result: true },
      })
      if (!current || current.status !== 'rejected' || current.type !== 'delegation') {
        return { state: 'changed' as const }
      }
      const result = jsonRecord(current.result)
      const messageId = result[DELEGATION_FALLBACK_MESSAGE_ID]
      if (typeof messageId === 'string' && messageId) {
        return { state: 'completed' as const, messageId }
      }
      if (result[DELEGATION_FALLBACK_FAILED] === true) {
        return { state: 'failed' as const }
      }
      const existingClaimId = result[DELEGATION_FALLBACK_CLAIM_ID]
      const existingClaimedAt = result[DELEGATION_FALLBACK_CLAIMED_AT]
      const claimedAtMs = typeof existingClaimedAt === 'string'
        ? Date.parse(existingClaimedAt)
        : Number.NaN
      if (typeof existingClaimId === 'string'
        && existingClaimId
        && Number.isFinite(claimedAtMs)
        && Date.now() - claimedAtMs < DELEGATION_FALLBACK_LEASE_MS) {
        return { state: 'running' as const }
      }
      await tx.agentPendingAction.update({
        where: { id: actionId },
        data: {
          result: {
            ...result,
            [DELEGATION_FALLBACK_CLAIM_ID]: claimId,
            [DELEGATION_FALLBACK_CLAIMED_AT]: new Date().toISOString(),
          },
        },
      })
      return { state: 'claimed' as const }
    })
    if (claim.state === 'completed') {
      await reconcilePlanTrackersForPendingAction(actionId)
      return Response.json({
        success: true, status: 'rejected', answered: true,
        assistantMessageId: claim.messageId, replayed: true,
      })
    }
    if (claim.state === 'running') {
      return Response.json({ success: true, status: 'rejected', fallbackStatus: 'running' }, { status: 202 })
    }
    if (claim.state !== 'claimed') {
      return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
    }
    let answer: string
    let tokensIn: number
    let tokensOut: number
    try {
      const r = await runHeadDirectAnswer(task)
      answer = r.text
      tokensIn = r.inputTokens
      tokensOut = r.outputTokens
      if (!answer) throw new Error('head_model_returned_empty_answer')
      if (!conversationId) throw new Error('delegation_conversation_missing')
    } catch (err) {
      console.warn('[reject] head direct answer failed:', err instanceof Error ? err.message : err)
      const message = err instanceof Error ? err.message : String(err)
      // Record failure and terminalize the exact owned row atomically. The
      // marker prevents a later HTTP retry from generating a duplicate answer.
      const failedByThisClaim = await db.$transaction(async (tx: typeof db) => {
        const lockKey = `pending-action-plan:${actionId}`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS lock_token`
        const current = await tx.agentPendingAction.findUnique({
          where: { id: actionId },
          select: { id: true, status: true, type: true, payload: true, result: true },
        })
        if (!current || current.status !== 'rejected' || current.type !== 'delegation') {
          return false
        }
        const currentResult = jsonRecord(current.result)
        if (currentResult[DELEGATION_FALLBACK_CLAIM_ID] !== claimId) return false
        await tx.agentPendingAction.update({
          where: { id: actionId },
          data: {
            result: {
              ...currentResult,
              [DELEGATION_FALLBACK_FAILED]: true,
              delegationFallbackError: message,
              [DELEGATION_FALLBACK_CLAIM_ID]: null,
              [DELEGATION_FALLBACK_CLAIMED_AT]: null,
            },
          },
        })
        await settleRejectedPlanStepsInTransaction(tx, {
          ...current,
          result: {
            ...currentResult,
            [DELEGATION_FALLBACK_FAILED]: true,
            delegationFallbackError: message,
            [DELEGATION_FALLBACK_CLAIM_ID]: null,
            [DELEGATION_FALLBACK_CLAIMED_AT]: null,
          },
        })
        return true
      })
      if (!failedByThisClaim) {
        return Response.json({ error: 'delegation_fallback_claim_lost', status: 'rejected' }, { status: 409 })
      }
      await settlePlanStepsLinkedToPendingAction(actionId)
      await reconcilePlanTrackersForPendingAction(actionId)
      return Response.json({ error: 'delegation_fallback_failed', status: 'rejected' }, { status: 502 })
    }
    const costUsd = calcModelTurnCostUsd(getModel(DEFAULT_MODEL_ID), { inputTokens: tokensIn, outputTokens: tokensOut })
    const completion = await db.$transaction(async (tx: typeof db) => {
      const lockKey = `pending-action-plan:${actionId}`
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS lock_token`
      const current = await tx.agentPendingAction.findUnique({
        where: { id: actionId },
        select: { id: true, status: true, type: true, payload: true, result: true },
      })
      if (!current || current.status !== 'rejected' || current.type !== 'delegation') {
        throw new Error('delegation_rejection_state_changed')
      }
      const currentResult = jsonRecord(current.result)
      const existingMessageId = currentResult[DELEGATION_FALLBACK_MESSAGE_ID]
      if (typeof existingMessageId === 'string' && existingMessageId) {
        return { state: 'completed' as const, messageId: existingMessageId, replayed: true }
      }
      if (currentResult[DELEGATION_FALLBACK_FAILED] === true) {
        throw new Error('delegation_fallback_already_failed')
      }
      if (currentResult[DELEGATION_FALLBACK_CLAIM_ID] !== claimId) {
        return { state: 'lost' as const }
      }
      const saved = await tx.agentMessage.create({
        data: {
          conversationId: conversationId!,
          role: 'assistant',
          content: [{ type: 'text', text: answer }],
          tokensIn,
          tokensOut,
          costUsd,
          usage: { input_tokens: tokensIn, output_tokens: tokensOut, model: getModel(DEFAULT_MODEL_ID).id, delegation_reject_answer: true },
        },
      })
      await tx.agentConversation.update({
        where: { id: conversationId! },
        data: { updatedAt: new Date() },
      })
      await completeRejectedDelegationPlanStepsInTransaction(tx, current, saved.id)
      await tx.agentPendingAction.update({
        where: { id: actionId },
        data: {
          result: {
            ...currentResult,
            [DELEGATION_FALLBACK_MESSAGE_ID]: saved.id,
            delegationFallback: 'head_answer',
            [DELEGATION_FALLBACK_CLAIM_ID]: null,
            [DELEGATION_FALLBACK_CLAIMED_AT]: null,
          },
        },
      })
      return { state: 'completed' as const, messageId: saved.id, replayed: false }
    })
    if (completion.state !== 'completed') {
      return Response.json({ error: 'delegation_fallback_claim_lost', status: 'rejected' }, { status: 409 })
    }
    await reconcilePlanTrackersForPendingAction(actionId)
    void logCost({
      provider: 'anthropic',
      kind: 'chat',
      units: { input_tokens: tokensIn, output_tokens: tokensOut, model: getModel(DEFAULT_MODEL_ID).id, via: 'delegation_reject_head_answer' },
      costUsd,
      conversationId,
      dedupKey: `delegreject:${actionId}`,
    }).catch(() => {})
    return Response.json({
      success: true,
      status: 'rejected',
      answered: true,
      assistantMessageId: completion.messageId,
      replayed: completion.replayed,
    })
  }

  if (action.type === 'content_gate1' || action.type === 'ad_creative_gate') {
    try {
      const { captureTasteSignalAsync } = await import('@/agent/lib/taste/capture')
      const pl = payload as { productCode?: string; variants?: Array<{ framedImagePath?: string | null; keep?: boolean }>; storagePath?: string; previewPath?: string }
      if (action.type === 'content_gate1' && pl.variants?.length) {
        for (const v of pl.variants) {
          if (v.framedImagePath) {
            captureTasteSignalAsync({
              verdict: 'reject',
              imagePath: v.framedImagePath,
              productCode: pl.productCode ?? null,
              source: 'content_gate1_reject',
            })
          }
        }
      } else {
        const path = pl.storagePath ?? pl.previewPath
        if (path) {
          captureTasteSignalAsync({
            verdict: 'reject',
            imagePath: path,
            productCode: pl.productCode ?? null,
            source: `${action.type}_reject`,
          })
        }
      }
    } catch (err) {
      console.warn('[reject] taste signal capture failed:', err instanceof Error ? err.message : err)
    }
  }

  // Append rejection note to conversation
  if (payload.conversationId) {
    await db.agentMessage.create({
      data: {
        conversationId: String(payload.conversationId),
        role: 'assistant',
        content: [{ type: 'text', text: 'Action rejected by owner.' }],
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      },
    })
    await prisma.agentConversation.update({
      where: { id: String(payload.conversationId) },
      data: { updatedAt: new Date() },
    })
  }

  return Response.json({ success: true, status: 'rejected' })
}

// Worker → App callback. Authenticated with AGENT_INTERNAL_TOKEN (constant-time compare).
// Does NOT use session auth — workers have no session cookie.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { enqueueAgentContinuation } from '@/agent/lib/approval-continuation'
import { finalizeTurnIfRunning } from '@/agent/lib/turn-status'
import { buildOutboundDialMessage } from '@/agent/lib/outbound-call-tracking'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import {
  shouldEmitGenericJobSuccess,
  shouldResumeAgentAfterImageWorkflow,
  shouldResumeAgentAfterJob,
} from '@/agent/lib/job-result-message-policy'
import {
  buildFallbackDeliveryMessage,
  hasUnansweredAskCard,
  isDeliverableJobType,
  markDelivered,
  markDeliveryPending,
  postAssistantMessage,
} from '@/agent/lib/job-delivery'
import { prisma } from '@/lib/prisma'
import {
  imageResultPaths,
  imageResultQcWarnings,
  signImageResultPreviews,
} from '@/agent/lib/image-result-contract'

const IMAGE_SIGNED_URL_TTL_SEC = 3600
const IMAGE_RESULT_CONTINUATION_MESSAGE =
  '[সিস্টেম নোট — অনুমোদিত ছবি তৈরি হয়েছে] Boss-এর approve-করা ছবিটি এইমাত্র তৈরি হয়ে কনভারসেশনে যোগ হয়েছে। ' +
  '**আগে PREVIEW CONFIRM (বাধ্যতামূলক — Boss-এর নিয়ম 2026-07-13):** ছবিটা Boss এখনো নিজের চোখে দেখেননি — ' +
  'reply-তে ছবিটা উল্লেখ করে ask_user card দাও: "ছবিটা ঠিক আছে?" (অপশন: "ঠিক আছে, পোস্ট রেডি করো" / "ছবি change চাই")। ' +
  'Boss "ঠিক আছে" বললে তবেই post_to_facebook/publish_to_instagram card দেবে — ছবি confirm হওয়ার আগে পোস্টের card দেওয়া নিষেধ। ' +
  'ছবিটা আর নতুন করে generate কোরো না।'

export const runtime = 'nodejs'
// The continuation may run INLINE here (up to 90s) when the VPS worker's turn
// consumer is down — see approval-continuation.ts. Default fn timeout is too short.
export const maxDuration = 120

function verifyToken(provided: string): boolean {
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

function resolveConversationId(action: { conversationId?: string | null; payload: unknown }) {
  const payload = action.payload as Record<string, unknown>
  const id = action.conversationId ?? payload.conversationId
  return typeof id === 'string' && id.trim() ? id.trim() : null
}

function normalizeJobStatus(raw: string): 'success' | 'failed' | null {
  if (raw === 'success') return 'success'
  if (raw === 'failed') return 'failed'
  // Legacy worker bug — treat as success so completed calls are not marked failed.
  if (raw === 'executed') {
    console.warn('[job-result] legacy status "executed" normalized to success')
    return 'success'
  }
  return null
}

interface JobResultBody {
  pendingActionId: string
  status: string
  data?: Record<string, unknown>
  error?: string
}

function imageTerminalEnvelope(value: unknown): {
  status: 'success' | 'failed'
  data?: Record<string, unknown>
  error?: string
  receiptId: string
  recordedAt: string
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (
    envelope.version !== 1
    || (envelope.status !== 'success' && envelope.status !== 'failed')
    || typeof envelope.receiptId !== 'string'
    || !envelope.receiptId
    || typeof envelope.recordedAt !== 'string'
    || !Number.isFinite(Date.parse(envelope.recordedAt))
  ) return null
  return {
    status: envelope.status,
    ...(envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? { data: envelope.data as Record<string, unknown> }
      : {}),
    ...(typeof envelope.error === 'string' ? { error: envelope.error } : {}),
    receiptId: envelope.receiptId,
    recordedAt: envelope.recordedAt,
  }
}

const imageDeliveryRequestId = (actionId: string) => `job-result:image:${actionId}`

async function buildImageDeliveryContent(
  pendingActionId: string,
  result: Record<string, unknown>,
): Promise<{ text: string; paths: string[]; content: Array<Record<string, unknown>> }> {
  const paths = imageResultPaths(result)
  const fallbackUrl = paths.length === 0 ? String(result.imageUrl ?? '').trim() : ''
  let text = paths.length === 1
    ? '✅ Image generated successfully.'
    : paths.length > 1
      ? `✅ ${paths.length} image variations generated successfully.`
      : '✅ Image generated successfully.'
  try {
    const signed = paths.length
      ? await signImageResultPreviews(
          paths,
          (path) => agentStorageSignedUrl(path, IMAGE_SIGNED_URL_TTL_SEC),
        )
      : { previews: [], failedPaths: [] }
    if (paths.length === 0 && !fallbackUrl) throw new Error('No image path in job result')
    const previews = signed.previews.map((preview) =>
      `![Generated image ${preview.index + 1}](${preview.url})`)
    if (fallbackUrl) previews.push(`![Generated image](${fallbackUrl})`)
    if (previews.length) text += `\n${previews.join('\n')}`
    if (signed.failedPaths.length) {
      console.warn('[job-result] some signed image previews failed', {
        pendingActionId,
        failedPaths: signed.failedPaths,
      })
      text += `\n\n_${signed.failedPaths.length} preview link(s) unavailable; completed images remain attached._`
    }
    const qcWarnings = imageResultQcWarnings(result)
    if (qcWarnings.length) text += `\n\n_${qcWarnings.join(' · ')}_`
  } catch (signError) {
    const detail = signError instanceof Error ? signError.message : String(signError)
    console.error('[job-result] signed URL failed', { pendingActionId, detail })
    text = paths.length
      ? `✅ ${paths.length} image(s) generated and attached.\n(Preview link could not be created.)`
      : fallbackUrl
        ? `✅ Image generated.\n(Preview link could not be created.)`
        : '✅ Image generated but preview unavailable.'
  }
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  for (const path of paths) {
    const ext = path.split('.').pop()?.toLowerCase()
    content.push({
      type: 'file_ref',
      bucket: 'agent-files',
      path,
      mediaType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png',
    })
  }
  return { text, paths, content }
}

async function reconcileTerminalImageDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  action: {
    id: string
    type: string
    status: string
    conversationId?: string | null
    payload: unknown
    result: unknown
  },
): Promise<boolean> {
  if (action.type !== 'image_gen' || !['executed', 'failed'].includes(action.status)) return false
  const payload = action.payload as Record<string, unknown>
  const conversationId = resolveConversationId(action)
  const result = action.result && typeof action.result === 'object'
    ? action.result as Record<string, unknown>
    : {}
  if (!conversationId) return false
  const contentPipeline = payload.contentPipeline as { gate1Id?: string } | undefined
  if (action.status === 'executed' && (payload.creativeStudio || contentPipeline?.gate1Id)) return false
  const delivery = action.status === 'failed'
    ? {
        content: [{
          type: 'text',
          text: `❌ কাজটি সম্পাদন ব্যর্থ হয়েছে।\nকারণ: ${String(result.error ?? 'Unknown error')}`,
        }],
      }
    : imageResultPaths(result).length > 0 || String(result.imageUrl ?? '').trim()
      ? await buildImageDeliveryContent(action.id, result)
      : null
  if (!delivery) return false
  await db.agentMessage.upsert({
    where: { clientRequestId: imageDeliveryRequestId(action.id) },
    update: { content: delivery.content },
    create: {
      clientRequestId: imageDeliveryRequestId(action.id),
      conversationId,
      role: 'assistant',
      content: delivery.content,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    },
  })
  await db.agentConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
  return true
}

async function reconcileExecutedImagePipeline(action: {
  id: string
  type: string
  status: string
  payload: unknown
  result: unknown
}): Promise<boolean> {
  if (action.type !== 'image_gen' || action.status !== 'executed') return false
  const payload = action.payload as Record<string, unknown>
  const pipeline = payload.contentPipeline as { gate1Id?: string } | undefined
  const result = action.result && typeof action.result === 'object'
    ? action.result as Record<string, unknown>
    : {}
  const storagePath = typeof result.storagePath === 'string' ? result.storagePath.trim() : ''
  if (!pipeline?.gate1Id || !storagePath) return false
  const { onPipelineRenderComplete } = await import('@/lib/content-engine/pipeline')
  await onPipelineRenderComplete(action.id, storagePath)
  return true
}

/** A 2xx callback is the acknowledgement for the worker's durable image
 * receipt. Keep the envelope for audit, but remove it from the replay queue
 * only after every required reconciliation/delivery above has succeeded. */
async function acknowledgeImageJobResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actionId: string,
  actionType: string,
  claimedAt: Date | null,
  processedEnvelope: unknown,
): Promise<boolean> {
  if (actionType !== 'image_gen') return true
  const acknowledged = await db.agentPendingAction.updateMany({
    where: {
      id: actionId,
      type: 'image_gen',
      jobResultPending: true,
      ...(claimedAt ? { jobResultClaimedAt: claimedAt } : {}),
      ...(imageTerminalEnvelope(processedEnvelope)?.receiptId
        ? {
            jobResultEnvelope: {
              path: ['receiptId'],
              equals: imageTerminalEnvelope(processedEnvelope)?.receiptId,
            },
          }
        : {}),
    },
    data: { jobResultPending: false, jobResultClaimedAt: null },
  })
  return acknowledged.count === 1
}

const IMAGE_RESULT_CLAIM_TTL_MS = 3 * 60_000

async function claimTerminalImageReconciliation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  actionId: string,
): Promise<Date | null> {
  const claimedAt = new Date()
  const staleBefore = new Date(claimedAt.getTime() - IMAGE_RESULT_CLAIM_TTL_MS)
  const claimed = await db.agentPendingAction.updateMany({
    where: {
      id: actionId,
      type: 'image_gen',
      jobResultPending: true,
      OR: [
        { jobResultClaimedAt: null },
        { jobResultClaimedAt: { lt: staleBefore } },
      ],
    },
    data: { jobResultClaimedAt: claimedAt },
  })
  return claimed.count === 1 ? claimedAt : null
}

async function reconcileTerminalImageRuntimeEffects(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  action: {
    id: string
    type: string
    status: string
    summary?: string | null
    conversationId?: string | null
    payload: unknown
    result: unknown
  },
) {
  if (action.type !== 'image_gen' || !['executed', 'failed'].includes(action.status)) return
  const payload = action.payload as Record<string, unknown>
  if (payload.campaignPack) return // campaign-pack reconciliation owns its stage UX
  const progressTurnId = typeof payload.progressTurnId === 'string' ? payload.progressTurnId : null
  const conversationId = resolveConversationId(action)
  let resumeProductPost = false

  const wf = await import('@/agent/lib/workflow-run')
  await wf.releaseWorkflowLease(action.id)
  await wf.syncWorkflowWithPendingAction(action.id, 'worker')
  if (action.status === 'executed') {
    const run = await wf.getWorkflowRunByPendingAction(action.id)
    resumeProductPost = shouldResumeAgentAfterImageWorkflow(run)
  }

  if (action.status === 'failed') {
    const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
    const result = action.result && typeof action.result === 'object'
      ? action.result as Record<string, unknown>
      : {}
    const goal = action.summary?.split('\n')[0]?.slice(0, 160) || 'image_gen job'
    const error = String(result.error ?? 'unknown_error').slice(0, 300)
    const checkpointId = await writeCheckpoint({
      taskRef: action.id,
      taskType: 'image_gen',
      goal,
      summaryBn: `"${goal}" কাজটা মাঝপথে ব্যর্থ হয়েছে।`,
      doneSteps: [],
      currentStep: 'worker executing image_gen',
      artifacts: [],
      error,
      nextActions: ['কারণ দেখে ঠিক করে কাজটা আবার চালাও, অথবা Boss-কে বিকল্প দাও'],
      resumeHint: `pendingAction ${action.id} failed with: ${error}. Retry creates a fresh owner approval card from the pinned inputs.`,
      conversationId,
    })
    if (!checkpointId) throw new Error('image_failure_checkpoint_reconcile_failed')
    if (progressTurnId) await finalizeTurnIfRunning(progressTurnId, 'error')
    return
  }

  const { resolveCheckpointByTaskRef } = await import('@/agent/lib/checkpoint')
  await resolveCheckpointByTaskRef(action.id)
  const result = action.result && typeof action.result === 'object'
    ? action.result as Record<string, unknown>
    : {}
  const hasVisibleImage = imageResultPaths(result).length > 0 || Boolean(String(result.imageUrl ?? '').trim())
  const pipeline = payload.contentPipeline as { gate1Id?: string } | undefined
  const genericChatImage = !payload.creativeStudio && !pipeline?.gate1Id
  if (resumeProductPost && genericChatImage && hasVisibleImage && conversationId) {
    await enqueueAgentContinuation({
      conversationId,
      turnId: progressTurnId,
      message: IMAGE_RESULT_CONTINUATION_MESSAGE,
    })
  } else if (progressTurnId) {
    await finalizeTurnIfRunning(progressTurnId, 'done')
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: JobResultBody
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { pendingActionId, status: rawStatus } = body
  let data = body.data
  let error = body.error
  if (!pendingActionId || !rawStatus) {
    return Response.json({ error: 'pendingActionId and status required' }, { status: 400 })
  }

  let status = normalizeJobStatus(rawStatus)
  if (!status) {
    console.error('[job-result] invalid status:', rawStatus)
    return Response.json({ error: 'invalid_status', allowed: ['success', 'failed'] }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  let processedImageEnvelope: unknown = action.jobResultEnvelope
  if (action.type === 'image_gen' && action.jobResultPending) {
    const durable = imageTerminalEnvelope(action.jobResultEnvelope)
    if (!durable) {
      return Response.json({
        error: 'invalid_image_terminal_envelope',
        retryable: true,
      }, { status: 503 })
    }
    // The worker persisted this receipt before HTTP delivery. It is the
    // canonical terminal fact; a stale/late failed callback cannot overwrite
    // an already-paid success envelope.
    status = durable.status
    data = durable.data
    error = durable.error
    processedImageEnvelope = action.jobResultEnvelope
  } else if (action.type === 'image_gen' && !['executed', 'failed'].includes(action.status)) {
    // Rolling/DB-outage adoption: an authenticated old worker (or a worker whose
    // outbox write failed) may reach the app without a pending envelope. Adopt
    // that receipt atomically with the terminal CAS so any later 503 remains
    // replayable instead of being fast-acked and lost.
    processedImageEnvelope = {
      version: 1,
      status,
      ...(data ? { data } : {}),
      ...(error ? { error } : {}),
      receiptId: `app-adopted:${pendingActionId}:${Date.now()}`,
      recordedAt: new Date().toISOString(),
    }
  }

  let imageResultClaimedAt: Date | null = null
  if (action.status === 'executed' || action.status === 'failed') {
    if (action.type === 'image_gen' && !action.jobResultPending) {
      return Response.json({ ok: true, idempotent: true, status: action.status })
    }
    if (action.type === 'image_gen') {
      imageResultClaimedAt = await claimTerminalImageReconciliation(db, action.id)
      if (!imageResultClaimedAt) {
        return Response.json({
          error: 'image_reconciliation_in_progress',
          retryable: true,
        }, { status: 409 })
      }
    }
    let terminalAction = action
    if (action.type === 'image_gen' && action.status === 'failed' && status === 'success') {
      const receiptId = imageTerminalEnvelope(processedImageEnvelope)?.receiptId
      const upgraded = await db.agentPendingAction.updateMany({
        where: {
          id: action.id,
          status: 'failed',
          jobResultClaimedAt: imageResultClaimedAt,
          ...(receiptId
            ? { jobResultEnvelope: { path: ['receiptId'], equals: receiptId } }
            : {}),
        },
        data: { status: 'executed', result: data ?? {}, resolvedAt: new Date() },
      })
      if (upgraded.count === 0) {
        return Response.json({ error: 'image_success_upgrade_raced', retryable: true }, { status: 503 })
      }
      terminalAction = { ...action, status: 'executed', result: data ?? {} }
    }
    // A callback may have committed the step result before chain advancement or
    // project-asset rebinding completed. Reconcile executed chain steps on
    // replay; constructors are receipt-deduped, so this cannot double-spend.
    const replayPayload = terminalAction.payload as Record<string, unknown> | null
    if (terminalAction.status === 'executed' && replayPayload?.familyChain) {
      try {
        const { advanceFamilyChain } = await import('@/lib/tryon/family-chain')
        const replayResult = terminalAction.result as Record<string, unknown> | null
        await advanceFamilyChain(
          terminalAction,
          typeof replayResult?.storagePath === 'string' ? replayResult.storagePath : undefined,
        )
      } catch (chainError) {
        console.error('[job-result] family-chain replay reconcile failed:', chainError)
        return Response.json({ error: 'family_chain_reconcile_failed' }, { status: 503 })
      }
    }
    if (replayPayload?.creativeStudio) {
      try {
        const { reconcileStudioResultProjectAsset } = await import('@/lib/creative-studio/project-service')
        await reconcileStudioResultProjectAsset(pendingActionId)
      } catch (assetError) {
        console.error('[job-result] studio project-asset replay reconcile failed:', assetError)
        return Response.json({ error: 'studio_project_asset_reconcile_failed' }, { status: 503 })
      }
    }
    if (terminalAction.status === 'executed' && terminalAction.type === 'image_gen') {
      try {
        await reconcileExecutedImagePipeline(terminalAction)
      } catch (pipelineError) {
        console.error('[job-result] content pipeline replay reconcile failed:', pipelineError)
        return Response.json({ error: 'content_pipeline_reconcile_failed' }, { status: 503 })
      }
    }
    if (terminalAction.status === 'executed' && terminalAction.type === 'image_gen') {
      try {
        await reconcileTerminalImageDelivery(db, terminalAction)
      } catch (deliveryError) {
        console.error('[job-result] image delivery replay reconcile failed:', deliveryError)
        return Response.json({ error: 'image_delivery_reconcile_failed' }, { status: 503 })
      }
    } else if (terminalAction.status === 'failed' && terminalAction.type === 'image_gen') {
      try {
        await reconcileTerminalImageDelivery(db, terminalAction)
      } catch (deliveryError) {
        console.error('[job-result] image failure delivery replay reconcile failed:', deliveryError)
        return Response.json({ error: 'image_delivery_reconcile_failed' }, { status: 503 })
      }
    }
    // CSE4 callback replay may mean the stage row committed but the pack
    // reconciliation/lineage write did not. Re-run that idempotent hook before
    // acknowledging the duplicate so a restart cannot leave the pack stale.
    const campaignPack = (terminalAction.payload as Record<string, unknown> | null)?.campaignPack
    if (campaignPack && typeof campaignPack === 'object') {
      try {
        const { reconcileCampaignPackStageResult } = await import('@/lib/creative-studio/campaign-pack-service')
        await reconcileCampaignPackStageResult(terminalAction.id)
      } catch (campaignError) {
        console.error('[job-result] campaign-pack replay reconcile failed:', campaignError)
        return Response.json({ error: 'campaign_pack_reconcile_failed' }, { status: 503 })
      }
    }
    try {
      await reconcileTerminalImageRuntimeEffects(db, terminalAction)
    } catch (runtimeError) {
      console.error('[job-result] image runtime-effects replay reconcile failed:', runtimeError)
      return Response.json({ error: 'image_runtime_reconcile_failed' }, { status: 503 })
    }
    if (!await acknowledgeImageJobResult(
      db,
      terminalAction.id,
      terminalAction.type,
      imageResultClaimedAt,
      processedImageEnvelope,
    )) {
      return Response.json({ error: 'image_result_receipt_changed', retryable: true }, { status: 503 })
    }
    return Response.json({ ok: true, idempotent: true, status: terminalAction.status })
  }

  const terminalData = {
    status: status === 'success' ? 'executed' : 'failed',
    result: data ?? { error },
    resolvedAt: new Date(),
  }
  if (action.type === 'image_gen') {
    imageResultClaimedAt = new Date()
    const processedReceiptId = imageTerminalEnvelope(processedImageEnvelope)?.receiptId
    const settled = await db.agentPendingAction.updateMany({
      where: {
        id: pendingActionId,
        status: action.status,
        // Match the exact durable fact read above. A worker receipt RPC may
        // atomically replace failure F with paid success S while this request
        // is in flight; stale F must then lose this CAS instead of overwriting
        // S and settling the action failed.
        ...(action.jobResultPending
          ? {
              jobResultPending: true,
              ...(processedReceiptId
                ? { jobResultEnvelope: { path: ['receiptId'], equals: processedReceiptId } }
                : {}),
            }
          : { jobResultPending: false }),
      },
      data: {
        ...terminalData,
        jobResultPending: true,
        jobResultEnvelope: processedImageEnvelope,
        jobResultClaimedAt: imageResultClaimedAt,
      },
    })
    if (settled.count === 0) {
      const current = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
      // A competing callback owns the full terminal reconcile. Never let the
      // CAS loser clear its outbox after running only a subset of the effects;
      // if that winner crashes, the durable receipt must remain replayable.
      return Response.json({
        error: 'image_terminal_reconciliation_pending',
        status: current?.status ?? 'missing',
        retryable: true,
      }, { status: 503 })
    }
  } else {
    await db.agentPendingAction.update({
      where: { id: pendingActionId },
      data: terminalData,
    })
  }

  // CSE4 stages own their completion UX inside CampaignPackProgress. Reconcile
  // the root pack + CSE3 asset lineage here, then stop before generic chat,
  // workflow, Telegram, or video approval-card side effects can fire.
  const campaignPack = (action.payload as Record<string, unknown> | null)?.campaignPack
  if (campaignPack && typeof campaignPack === 'object') {
    try {
      const { reconcileCampaignPackStageResult } = await import('@/lib/creative-studio/campaign-pack-service')
      await reconcileCampaignPackStageResult(action.id)
      await reconcileTerminalImageRuntimeEffects(db, {
        ...action,
        status: status === 'success' ? 'executed' : 'failed',
        result: data ?? { error },
      })
      if (!await acknowledgeImageJobResult(
        db,
        action.id,
        action.type,
        imageResultClaimedAt,
        processedImageEnvelope,
      )) {
        return Response.json({ error: 'image_result_receipt_changed', retryable: true }, { status: 503 })
      }
      return Response.json({ ok: true, campaignPack: true })
    } catch (campaignError) {
      console.error('[job-result] campaign-pack reconcile failed:', campaignError)
      return Response.json({ error: 'campaign_pack_reconcile_failed' }, { status: 503 })
    }
  }

  // Phase 5: the worker reported — free the execution lease and sync the
  // canonical WorkflowRun to the card's final status right away (turn-start
  // reconcile would catch it later; doing it here keeps the run's step honest
  // for anything reading it between now and the next turn). Fail-open.
  const resumeProductPostAfterImage = false
  // Image callbacks use reconcileTerminalImageRuntimeEffects below, after
  // deterministic artifact/failure delivery. Replay uses that exact helper
  // too, so the outbox has one shared acknowledgement gate.
  if (action.type !== 'image_gen') {
    try {
      const wf = await import('@/agent/lib/workflow-run')
      await wf.releaseWorkflowLease(pendingActionId)
      // Awaited: the continuation must read the post-worker state (report step),
      // never race the old waiting-worker state and go silent.
      await wf.syncWorkflowWithPendingAction(pendingActionId, 'worker')
    } catch (err) {
      console.warn('[job-result] workflow sync failed open:', err instanceof Error ? err.message : err)
    }
  }

  // Delivery contract: from this moment the owner is OWED the result in his
  // conversation. The sweep in job-delivery.ts retries the continuation and, if
  // the head still says nothing, posts the result itself.
  if (status === 'success' && isDeliverableJobType(action.type)) {
    await markDeliveryPending(pendingActionId, action.type)
  }

  // SEO: build the client report, the issues CSV and the live HTML dashboard
  // NOW and file the dashboard as a chat artifact. Report quality no longer
  // depends on the head remembering to ask for it (incident 2026-07-25).
  if (status === 'success' && action.type === 'seo_audit') {
    try {
      const { buildSeoDeliverables } = await import('@/agent/lib/seo-deliverables')
      const built = await buildSeoDeliverables(pendingActionId)
      if (built) console.log(`[job-result] seo deliverables ready for ${built.host} (${built.pagesCrawled} pages)`)
    } catch (err) {
      // The raw result stays durable; the head's read:"report" path can still
      // build everything on demand.
      console.warn('[job-result] seo deliverables build failed:', err instanceof Error ? err.message : err)
    }
  }

  const payload = action.payload as Record<string, unknown>

  // Progress turn opened at approve time ("ছবিটা বানাতে দিচ্ছি…" + spinner) — the
  // continuation below reuses it; any other exit closes it so the app's spinner
  // never runs forever.
  const progressTurnId = typeof payload.progressTurnId === 'string' ? payload.progressTurnId : null

  // Family-chain assembly line: a finished step queues the next one (adult shot →
  // child garment → child shot → merge). Best-effort — a chain problem must never
  // fail the worker callback; the chain simply stalls and the tracker shows it.
  if (payload.familyChain && status === 'success') {
    try {
      const { advanceFamilyChain } = await import('@/lib/tryon/family-chain')
      const storagePath = typeof data?.storagePath === 'string' ? data.storagePath : undefined
      // pass the FRESH result (garment_prep crops ride it) — `action` was
      // fetched before the update above
      const nextId = await advanceFamilyChain({ ...action, result: data ?? undefined }, storagePath)
      if (nextId) console.log(`[job-result] family chain advanced ${pendingActionId} → ${nextId}`)
    } catch (chainErr) {
      console.error('[job-result] family chain advance failed:', chainErr)
      if (action.type === 'image_gen') {
        return Response.json({ error: 'family_chain_reconcile_failed' }, { status: 503 })
      }
    }
  }

  // The final artifact belongs in its signed project even if the browser tab
  // closed before the old client-side catalog POST. Await and retry through the
  // idempotent callback path so Gallery can never silently lose a paid result.
  if (payload.creativeStudio) {
    try {
      const { reconcileStudioResultProjectAsset } = await import('@/lib/creative-studio/project-service')
      await reconcileStudioResultProjectAsset(pendingActionId)
    } catch (assetError) {
      console.error('[job-result] studio project-asset reconcile failed:', assetError)
      return Response.json({ error: 'studio_project_asset_reconcile_failed' }, { status: 503 })
    }
  }

  // V4 multi-clip Veo reel: a finished clip queues the next clip / the concat.
  if (payload.veoChain && status === 'success') {
    try {
      const { advanceVeoChain } = await import('@/lib/creative-studio/veo-chain')
      const sp = typeof data?.storagePath === 'string' ? data.storagePath : undefined
      const nextId = await advanceVeoChain(action, sp)
      if (nextId) console.log(`[job-result] veo chain advanced ${pendingActionId} → ${nextId}`)
    } catch (chainErr) {
      console.error('[job-result] veo chain advance failed:', chainErr)
    }
  }

  // CS4: optional Telegram ping when a studio artifact is READY (kv toggle,
  // default off — studio jobs stay silent by design). Only FINAL artifacts:
  // internal chain steps and non-final chain/veo clips never ping.
  if (status === 'success' && payload.creativeStudio && !payload.chainInternal) {
    try {
      const chain = payload.familyChain as { stepIndex?: number; plan?: string[] } | undefined
      const isFinal = chain
        ? Number(chain.stepIndex) === (chain.plan?.length ?? 1) - 1
        : !payload.veoChain
      if (isFinal) {
        const { readKv, NOTIFY_KEY } = await import('@/lib/creative-studio/taste')
        if ((await readKv(NOTIFY_KEY)) === '1') {
          const tg = await sendOwnerText(`✅ Boss, "${action.summary}" রেডি — Studio Gallery-তে দেখুন।`)
          if (!tg.ok) console.warn('[job-result] studio done-ping failed:', tg.error)
        }
      }
    } catch (pingErr) {
      console.warn('[job-result] studio done-ping error:', pingErr)
    }
  }

  const convId = resolveConversationId(action)
  let messageText: string | null = null
  /** Storage path of a generated image — persisted as a file_ref block so the
   * NATIVE app shows the actual picture (it renders images only from file_ref;
   * a markdown image link is plain text there — owner report 2026-07-13). */
  let messageImagePaths: string[] = []
  let pushTelegram = false
  // True only for a plain image_gen success that just posted its image into the
  // conversation. That is the moment the head can finally chain to the next step
  // (e.g. an Instagram post), so we resume it AFTER the artifact lands — never at
  // approval time (image isn't generated yet then). Batch/creative-studio jobs,
  // content-pipeline gates and the video reel gate own their own follow-up, so they
  // stay false.
  let resumeAgentAfterImage = false
  const resumeAgentAfterSeo = shouldResumeAgentAfterJob(action.type, status)

  if (action.type === 'outbound_call' && status === 'success') {
    const phone = String(payload.phone ?? '')
    const callSid = typeof data?.callSid === 'string' ? data.callSid : undefined
    messageText = buildOutboundDialMessage(phone, callSid)
    pushTelegram = true
  } else if (status === 'success' && (data?.storagePath || data?.imageUrl)) {
    const storagePath = typeof data?.storagePath === 'string' ? data.storagePath.trim() : ''
    const isVideo = action.type === 'video_gen' || storagePath.endsWith('.mp4') || data?.mediaType === 'video'
    const cp = payload.contentPipeline as { gate1Id?: string } | undefined
    if (payload.creativeStudio) {
      messageText = null
    } else if (cp?.gate1Id && storagePath && !isVideo) {
      try {
        const { onPipelineRenderComplete } = await import('@/lib/content-engine/pipeline')
        await onPipelineRenderComplete(pendingActionId, storagePath)
      } catch (pipeErr) {
        console.error('[job-result] content pipeline advance failed:', pipeErr)
        return Response.json({ error: 'content_pipeline_reconcile_failed' }, { status: 503 })
      }
      messageText = null
    } else if (isVideo && storagePath) {
      try {
        const { createVideoReelGate } = await import('@/lib/content-engine/video-reel-gate')
        const videoUrl = await agentStorageSignedUrl(storagePath, IMAGE_SIGNED_URL_TTL_SEC)
        await createVideoReelGate({
          storagePath,
          productCode: typeof data?.productCode === 'string' ? data.productCode : null,
          aspect: typeof data?.aspect === 'string' ? data.aspect : '9:16',
          durationSec: typeof data?.durationSec === 'number' ? data.durationSec : 6,
          conversationId: convId,
          sourceActionId: pendingActionId,
        })
        messageText =
          `🎬 Product reel generated (${data?.durationSec ?? 6}s).\n` +
          `[Watch preview](${videoUrl})\n\n` +
          'Owner approval card sent — nothing auto-posted.'
      } catch (gateErr) {
        const detail = gateErr instanceof Error ? gateErr.message : String(gateErr)
        console.error('[job-result] video reel gate failed:', detail)
        messageText = `✅ Reel saved: \`${storagePath}\` (approval card failed: ${detail})`
      }
    } else {
      const delivery = await buildImageDeliveryContent(pendingActionId, data)
      // Persist these independently of ephemeral preview signing. Native image
      // cards are driven by file_ref blocks, not by signed Markdown URLs.
      messageImagePaths = delivery.paths
      messageText = delivery.text
      resumeAgentAfterImage = messageImagePaths.length > 0 && resumeProductPostAfterImage
    }
  } else if (action.type === 'outbound_call' && status === 'failed') {
    messageText = `❌ বস, কল দেওয়া যায়নি।\nকারণ: ${error ?? String(data?.error ?? 'Unknown error')}`
    pushTelegram = true
  } else if (status === 'failed') {
    messageText = `❌ কাজটি সম্পাদন ব্যর্থ হয়েছে।\nকারণ: ${error ?? 'Unknown error'}`
  } else if (status === 'success' && !shouldEmitGenericJobSuccess(action.type)) {
    // The head polls this durable action and delivers the real score/report/file.
    // A second context-free assistant bubble ("কাজটি সফল...") interleaved with
    // that turn and made the owner think the agent had restarted on its own.
    messageText = null
  } else if (status === 'success') {
    messageText = `✅ কাজটি সফলভাবে সম্পাদিত হয়েছে।`
  }

  // P0 terminal-state contract: EVERY worker-job failure leaves a checkpoint the
  // owner's next reply can resume from — this one hook covers all job types.
  if (status === 'failed' && action.type !== 'image_gen') {
    try {
      const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
      const goal = (action.summary as string | null)?.split('\n')[0]?.slice(0, 160) || `${action.type} job`
      const errMsg = (error ?? String(data?.error ?? 'unknown_error')).slice(0, 300)
      const partial = typeof data?.storagePath === 'string' ? [data.storagePath] : []
      const checkpointId = await writeCheckpoint({
        taskRef: pendingActionId,
        taskType: action.type,
        goal,
        summaryBn: `"${goal}" কাজটা মাঝপথে ব্যর্থ হয়েছে।`,
        doneSteps: [],
        currentStep: `worker executing ${action.type}`,
        artifacts: partial,
        error: errMsg,
        nextActions: ['কারণ দেখে ঠিক করে কাজটা আবার চালাও (নতুন approved action বানিয়ে), অথবা Boss-কে বিকল্প দাও'],
        resumeHint: `pendingAction ${pendingActionId} (type ${action.type}) failed with: ${errMsg}. Payload payload-এ আগের সব input আছে — same payload দিয়ে retry করা যায়।`,
        conversationId: convId,
      })
      if (action.type === 'image_gen' && !checkpointId) {
        return Response.json({ error: 'image_failure_checkpoint_reconcile_failed' }, { status: 503 })
      }
    } catch (cpErr) {
      console.error('[job-result] checkpoint write failed:', cpErr)
      if (action.type === 'image_gen') {
        return Response.json({ error: 'image_failure_checkpoint_reconcile_failed' }, { status: 503 })
      }
    }
  } else if (status === 'success' && action.type !== 'image_gen') {
    // a retried task that now succeeded closes its old checkpoint chip
    try {
      const { resolveCheckpointByTaskRef } = await import('@/agent/lib/checkpoint')
      await resolveCheckpointByTaskRef(pendingActionId)
    } catch { /* best-effort */ }
  }

  if (convId && messageText) {
    const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: messageText }]
    for (const messageImagePath of messageImagePaths) {
      const ext = messageImagePath.split('.').pop()?.toLowerCase()
      contentBlocks.push({
        type: 'file_ref',
        bucket: 'agent-files',
        path: messageImagePath,
        mediaType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png',
      })
    }
    const messageData = {
      conversationId: convId,
      role: 'assistant',
      content: contentBlocks,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    }
    if (action.type === 'image_gen') {
      await db.agentMessage.upsert({
        where: { clientRequestId: imageDeliveryRequestId(pendingActionId) },
        update: { content: contentBlocks },
        create: { ...messageData, clientRequestId: imageDeliveryRequestId(pendingActionId) },
      })
    } else {
      await db.agentMessage.create({ data: messageData })
    }
    await prisma.agentConversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    })
  }

  if (pushTelegram && messageText) {
    const tg = await sendOwnerText(messageText)
    if (!tg.ok) console.warn('[job-result] owner telegram notify failed:', tg.error)
  }

  // The progress turn must stay OPEN while a continuation is about to present the
  // result — finalizing it here is what literally put "done" on the owner's screen
  // while the SEO report was still unwritten (2026-07-25).
  if (action.type !== 'image_gen' && progressTurnId && (status === 'failed' || (!resumeAgentAfterImage && !resumeAgentAfterSeo))) {
    try {
      await finalizeTurnIfRunning(progressTurnId, status === 'failed' ? 'error' : 'done')
    } catch (turnError) {
      if (action.type === 'image_gen') {
        console.error('[job-result] image progress-turn reconcile failed:', turnError)
        return Response.json({ error: 'image_progress_turn_reconcile_failed' }, { status: 503 })
      }
    }
  }

  // The generated image is now in the conversation → resume the head so it carries on
  // its task (e.g. build the Instagram/Facebook post it was about to make) instead of
  // going silent. Best-effort: no-ops without a worker queue or if the owner disabled
  // auto-continue, and never fails the worker callback.
  if (action.type !== 'image_gen' && resumeAgentAfterImage && convId) {
    try {
      await enqueueAgentContinuation({
        conversationId: convId,
        // Reuse the progress turn opened at approve time ("ছবিটা বানাতে দিচ্ছি…")
        // so the app's spinner runs from the owner's tap straight through to
        // this reply (Claude-Code-parity progress, owner ask 2026-07-13).
        turnId: progressTurnId,
        message: IMAGE_RESULT_CONTINUATION_MESSAGE,
      })
    } catch (err) {
      console.warn('[job-result] agent continuation enqueue failed (result unaffected):', err instanceof Error ? err.message : err)
    }
  }

  // SEO is also an async job. Its executed result is not the deliverable: the
  // head must read the full report + links, then advance the durable ordered
  // batch to the next site. Previously only images resumed, so site 1 completed
  // in the worker while the owner conversation stayed permanently stranded.
  if (resumeAgentAfterSeo && convId) {
    try {
      // Boss has an open question: resuming the head would answer over it. He
      // still gets the finished report — the server posts it and the card keeps
      // waiting (owner ruling 2026-07-25).
      if (await hasUnansweredAskCard(convId)) {
        const fresh = await db.agentPendingAction.findUnique({
          where: { id: pendingActionId },
          select: { type: true, summary: true, result: true },
        })
        if (fresh) {
          await postAssistantMessage(convId, buildFallbackDeliveryMessage(fresh))
          await markDelivered(pendingActionId, 'server_fallback')
        }
        return Response.json({ success: true, deliveredWhileAwaitingOwner: true })
      }
      // DELIVERY SPINE (owner incident 2026-07-25, second half): the head used to
      // be the ONLY writer of the report message, so a long reply that ran into
      // the serverless deadline reached Boss cut mid-sentence ("**বাকি মূল সম").
      // The server-built summary is complete, bounded and already computed at
      // deliverable-build time — post THAT first, mark the job delivered, and let
      // the head add only the extra it verified. A deadline can now truncate the
      // commentary, never the report.
      const freshForSpine = await db.agentPendingAction.findUnique({
        where: { id: pendingActionId },
        select: { type: true, summary: true, result: true },
      })
      let spinePosted = false
      if (freshForSpine) {
        try {
          await postAssistantMessage(convId, buildFallbackDeliveryMessage(freshForSpine))
          await markDelivered(pendingActionId, 'server_spine')
          spinePosted = true
        } catch (err) {
          console.warn('[job-result] delivery spine post failed:', err instanceof Error ? err.message : err)
        }
      }

      await enqueueAgentContinuation({
        conversationId: convId,
        // Presenting a finished deliverable is correctness, not an
        // approval convenience — it must not depend on the auto-continue
        // preference, and it reuses the progress turn so the owner sees one
        // unbroken span from his request to the report.
        force: true,
        turnId: progressTurnId,
        message:
          `[INTERNAL SEO JOB RESULT] Audit action ${pendingActionId} is now executed. ` +
          (spinePosted
            ? 'The score, coverage, severity counts and every download link have ALREADY been posted to Boss ' +
              'by the server — do NOT repeat them. Add only what you can verify yourself on top of that: the ' +
              'critical/high issues with their concrete fix, and what to do first. Keep it under ~15 lines so ' +
              'the turn finishes inside its deadline. Then resume the canonical client_seo_batch at its exact next tool. '
            : 'Resume the canonical client_seo_batch at its exact next tool. Read the full report (read:"report") ' +
              'and the links (read:"links"), then PRESENT them in this reply: score, every critical/high issue with ' +
              'its fix, what to do first, and the download links. ') +
          'Never rerun a completed audit, never ask Boss ' +
          'whether he wants the report, and never end this turn with only a progress line.',
      })
    } catch (err) {
      console.warn('[job-result] SEO continuation enqueue failed (result remains durable):', err instanceof Error ? err.message : err)
    }
  }

  try {
    await reconcileTerminalImageRuntimeEffects(db, {
      ...action,
      status: status === 'success' ? 'executed' : 'failed',
      result: data ?? { error },
    })
  } catch (runtimeError) {
    console.error('[job-result] image runtime-effects reconcile failed:', runtimeError)
    return Response.json({ error: 'image_runtime_reconcile_failed' }, { status: 503 })
  }
  if (!await acknowledgeImageJobResult(
    db,
    pendingActionId,
    action.type,
    imageResultClaimedAt,
    processedImageEnvelope,
  )) {
    return Response.json({ error: 'image_result_receipt_changed', retryable: true }, { status: 503 })
  }
  return Response.json({ success: true })
}

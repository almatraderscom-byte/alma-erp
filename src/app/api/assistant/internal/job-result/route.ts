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
import { shouldEmitGenericJobSuccess, shouldResumeAgentAfterJob } from '@/agent/lib/job-result-message-policy'
import { prisma } from '@/lib/prisma'

const IMAGE_SIGNED_URL_TTL_SEC = 3600

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

  const { pendingActionId, status: rawStatus, data, error } = body
  if (!pendingActionId || !rawStatus) {
    return Response.json({ error: 'pendingActionId and status required' }, { status: 400 })
  }

  const status = normalizeJobStatus(rawStatus)
  if (!status) {
    console.error('[job-result] invalid status:', rawStatus)
    return Response.json({ error: 'invalid_status', allowed: ['success', 'failed'] }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const action = await db.agentPendingAction.findUnique({ where: { id: pendingActionId } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  if (action.status === 'executed' || action.status === 'failed') {
    return Response.json({ ok: true, idempotent: true, status: action.status })
  }

  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      status: status === 'success' ? 'executed' : 'failed',
      result: data ?? { error },
      resolvedAt: new Date(),
    },
  })

  // Phase 5: the worker reported — free the execution lease and sync the
  // canonical WorkflowRun to the card's final status right away (turn-start
  // reconcile would catch it later; doing it here keeps the run's step honest
  // for anything reading it between now and the next turn). Fail-open.
  try {
    const wf = await import('@/agent/lib/workflow-run')
    await wf.releaseWorkflowLease(pendingActionId)
    // Awaited: the continuation must read the post-worker state (report step),
    // never race the old waiting-worker state and go silent.
    await wf.syncWorkflowWithPendingAction(pendingActionId, 'worker')
  } catch (err) {
    console.warn('[job-result] workflow sync failed open:', err instanceof Error ? err.message : err)
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
      const nextId = await advanceFamilyChain(action, storagePath)
      if (nextId) console.log(`[job-result] family chain advanced ${pendingActionId} → ${nextId}`)
    } catch (chainErr) {
      console.error('[job-result] family chain advance failed:', chainErr)
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
  let messageImagePath: string | null = null
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
      try {
        const imageUrl = storagePath
          ? await agentStorageSignedUrl(storagePath, IMAGE_SIGNED_URL_TTL_SEC)
          : String(data?.imageUrl ?? '')
        if (!imageUrl) throw new Error('No image path in job result')
        messageText = `✅ Image generated successfully.\n![Generated image](${imageUrl})`
        // The native app renders images ONLY from file_ref content blocks —
        // markdown image links display as plain text there, so the owner
        // couldn't see the preview he was asked to confirm (2026-07-13).
        if (storagePath) {
          messageImagePath = storagePath
        }
        resumeAgentAfterImage = true
        const qcFlag = typeof data?.qc === 'object' && data.qc !== null
          ? (data.qc as { flagged?: string }).flagged
          : undefined
        if (qcFlag) {
          messageText += `\n\n_${qcFlag}_`
        }
      } catch (signErr) {
        const detail = signErr instanceof Error ? signErr.message : String(signErr)
        console.error('[job-result] signed URL failed', { storagePath, detail })
        messageText = storagePath
          ? `✅ Image generated and saved.\nPath: \`${storagePath}\`\n(Preview link could not be created — check Supabase storage config.)`
          : `✅ Image generated but preview unavailable.`
      }
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
  if (status === 'failed') {
    try {
      const { writeCheckpoint } = await import('@/agent/lib/checkpoint')
      const goal = (action.summary as string | null)?.split('\n')[0]?.slice(0, 160) || `${action.type} job`
      const errMsg = (error ?? String(data?.error ?? 'unknown_error')).slice(0, 300)
      const partial = typeof data?.storagePath === 'string' ? [data.storagePath] : []
      await writeCheckpoint({
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
    } catch (cpErr) {
      console.error('[job-result] checkpoint write failed:', cpErr)
    }
  } else if (status === 'success') {
    // a retried task that now succeeded closes its old checkpoint chip
    try {
      const { resolveCheckpointByTaskRef } = await import('@/agent/lib/checkpoint')
      await resolveCheckpointByTaskRef(pendingActionId)
    } catch { /* best-effort */ }
  }

  if (convId && messageText) {
    const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: messageText }]
    if (messageImagePath) {
      const ext = messageImagePath.split('.').pop()?.toLowerCase()
      contentBlocks.push({
        type: 'file_ref',
        bucket: 'agent-files',
        path: messageImagePath,
        mediaType: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png',
      })
    }
    await db.agentMessage.create({
      data: {
        conversationId: convId,
        role: 'assistant',
        content: contentBlocks,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      },
    })
    await prisma.agentConversation.update({
      where: { id: convId },
      data: { updatedAt: new Date() },
    })
  }

  if (pushTelegram && messageText) {
    const tg = await sendOwnerText(messageText)
    if (!tg.ok) console.warn('[job-result] owner telegram notify failed:', tg.error)
  }

  if (progressTurnId && (status === 'failed' || !resumeAgentAfterImage)) {
    await finalizeTurnIfRunning(progressTurnId, status === 'failed' ? 'error' : 'done').catch(() => {})
  }

  // The generated image is now in the conversation → resume the head so it carries on
  // its task (e.g. build the Instagram/Facebook post it was about to make) instead of
  // going silent. Best-effort: no-ops without a worker queue or if the owner disabled
  // auto-continue, and never fails the worker callback.
  if (resumeAgentAfterImage && convId) {
    try {
      await enqueueAgentContinuation({
        conversationId: convId,
        // Reuse the progress turn opened at approve time ("ছবিটা বানাতে দিচ্ছি…")
        // so the app's spinner runs from the owner's tap straight through to
        // this reply (Claude-Code-parity progress, owner ask 2026-07-13).
        turnId: progressTurnId,
        message:
          '[সিস্টেম নোট — অনুমোদিত ছবি তৈরি হয়েছে] Boss-এর approve-করা ছবিটি এইমাত্র তৈরি হয়ে কনভারসেশনে যোগ হয়েছে। ' +
          '**আগে PREVIEW CONFIRM (বাধ্যতামূলক — Boss-এর নিয়ম 2026-07-13):** ছবিটা Boss এখনো নিজের চোখে দেখেননি — ' +
          'reply-তে ছবিটা উল্লেখ করে ask_user card দাও: "ছবিটা ঠিক আছে?" (অপশন: "ঠিক আছে, পোস্ট রেডি করো" / "ছবি change চাই")। ' +
          'Boss "ঠিক আছে" বললে তবেই post_to_facebook/publish_to_instagram card দেবে — ছবি confirm হওয়ার আগে পোস্টের card দেওয়া নিষেধ। ' +
          'ছবিটা আর নতুন করে generate কোরো না।',
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
      await enqueueAgentContinuation({
        conversationId: convId,
        message:
          `[INTERNAL SEO JOB RESULT] Audit action ${pendingActionId} is now executed. ` +
          'Resume the canonical client_seo_batch at its exact next tool. Read the full report and links; ' +
          'then continue the next ordered target. Never rerun a completed audit and never ask Boss to type continue.',
      })
    } catch (err) {
      console.warn('[job-result] SEO continuation enqueue failed (result remains durable):', err instanceof Error ? err.message : err)
    }
  }

  return Response.json({ success: true })
}

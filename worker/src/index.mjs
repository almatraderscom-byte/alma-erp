/**
 * ALMA Agent Worker — BullMQ job processor + Telegram bridge.
 * Runs on the VPS (not on Vercel).
 *
 * Architecture:
 * - Polls GET /api/assistant/internal/pending-jobs every 30s for new approved actions
 * - Adds them to local BullMQ queues for durable processing with retry
 * - Reports results back via POST /api/assistant/internal/job-result
 * - Runs Telegraf long-polling for the assistant Telegram bot
 */

import './env-bootstrap.mjs'
// CRITICAL: Install Telegram proxy BEFORE any module that does fetch to api.telegram.org.
import { installTelegramProxy } from './telegram-proxy.mjs'
installTelegramProxy()
import { initWorkerSentry, captureWorkerError } from './sentry.mjs'
import { startHeartbeatLoop } from './heartbeat.mjs'
import { startHealthPingLoop } from './health-ping.mjs'
import { Queue, Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { getAppUrl, getInternalToken } from './env.mjs'
import { launchTelegramBot, stopTelegramBot } from './telegram/launcher.mjs'
import { loadOwnerStateFromKv } from './telegram/owner-state-persist.mjs'
import { hydrateAwaitingProof } from './staff/task-verification.mjs'
import { setupSchedulers } from './schedulers/index.mjs'
import { dispatchTasksToStaff } from './staff/dispatch.mjs'
import { sendStaffAnnouncement } from './staff/announcement.mjs'
import { initializeDailySalahRecords } from './salah/scheduler.mjs'
import { startTwilioHttpServer } from './twilio-http.mjs'
import { deliverAgentTurn } from './telegram/agent-turn.mjs'
import { startDiagnosticHttpServer, setRetriggerHandler } from './diagnostic-http.mjs'
import { processVideoGen } from './video-gen.mjs'
import { processVideoEdit } from './video-edit.mjs'

// ── Env checks ─────────────────────────────────────────────────────────────

const required = [
  'REDIS_URL',
  'APP_URL',
  'AGENT_INTERNAL_TOKEN',
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]
initWorkerSentry()

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[worker] Missing required env var: ${key}`)
    process.exit(1)
  }
}

const REDIS_URL      = process.env.REDIS_URL
// A2 long-agent-task spans two machines: the Vercel route enqueues, this VPS worker
// consumes. They must share a Redis both can reach (cloud Upstash). Every OTHER queue
// stays on the worker's local REDIS_URL — moving those live queues to a free-tier
// cloud Redis would add latency and risk its command quota. Falls back to REDIS_URL.
const LONG_TASK_REDIS_URL = process.env.LONG_TASK_REDIS_URL || REDIS_URL
const GEMINI_KEY     = process.env.GEMINI_API_KEY
const SUPABASE_URL   = process.env.SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Clients ────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const genai    = new GoogleGenAI({ apiKey: GEMINI_KEY })

const connection = { url: REDIS_URL }
const longTaskConnection = { url: LONG_TASK_REDIS_URL }

// ── Queues ─────────────────────────────────────────────────────────────────

const imageGenQueue = new Queue('image-gen', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
})

const videoGenQueue = new Queue('video-gen', {
  connection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 15000 } },
})

// Phase V1: deterministic ffmpeg reel editing of the owner's own shoots.
// attempts:2 — a transient failure (download hiccup, OOM) retries once; the
// P0 checkpoint on the failed job-result is the owner-visible fallback.
const videoEditQueue = new Queue('video-edit', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
})

// Phase V3: Remotion motion-template finishing (attempts:2 — bundling/browser
// hiccups are transient; the P0 checkpoint covers the final failure).
const videoFinishQueue = new Queue('video-finish', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
})

// E1: ElevenLabs Audio Lab jobs (owner-initiated only).
const audioGenQueue = new Queue('audio-gen', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 20000 } },
})

const longTaskQueue = new Queue('long-agent-task', {
  connection: longTaskConnection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 10000 } },
})

// P2 workbench — the agent's sandboxed "own computer" (see workbench/executor.mjs).
// attempts:1 — a failed run must NOT silently auto-retry the same commands; the
// P0 checkpoint written on the failed job-result is the retry path (head decides).
const workbenchQueue = new Queue('workbench', {
  connection,
  defaultJobOptions: { attempts: 1 },
})

// Client-SEO end-to-end audit (crawl + audit ANY public site). attempts:1 for
// the same reason as workbench — a failed audit checkpoints, never silently
// re-crawls someone's site.
const seoAuditQueue = new Queue('seo-audit', {
  connection,
  defaultJobOptions: { attempts: 1 },
})

// Track enqueued action IDs to avoid duplicates in polling window
const enqueuedIds = new Set()
const stuckReenqueueCounts = new Map()

const STUCK_APPROVED_MS = 10 * 60 * 1000
const STUCK_MAX_REENQUEUES = 5
const DISPATCH_JOB_TYPES = new Set(['dispatch_staff_tasks', 'add_staff_task_now', 'staff_announcement'])

async function tasksAlreadyDispatchedForJob(supabase, job) {
  if (job.type !== 'dispatch_staff_tasks' && job.type !== 'add_staff_task_now') return false
  const date = job.payload?.date
  if (!date) return false
  const taskIds = job.payload?.taskIds
    ?? (job.payload?.taskId ? [job.payload.taskId] : null)

  if (Array.isArray(taskIds) && taskIds.length) {
    const { data: rows } = await supabase
      .from('staff_tasks')
      .select('id, status')
      .in('id', taskIds)
    if (!rows?.length) return false
    return rows.every((r) => ['sent', 'done'].includes(r.status))
  }

  const { count: approvedCount } = await supabase
    .from('staff_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('proposed_for', date)
    .eq('status', 'approved')
  if ((approvedCount ?? 0) > 0) return false

  const { count } = await supabase
    .from('staff_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('proposed_for', date)
    .in('status', ['sent', 'done'])
  return (count ?? 0) > 0
}

function isStuckApprovedJob(job) {
  if (job.status !== 'approved' || job.result) return false
  const resolvedAt = job.resolvedAt ?? job.resolved_at
  if (!resolvedAt) return false
  return Date.now() - new Date(resolvedAt).getTime() > STUCK_APPROVED_MS
}

async function reconcileStuckApprovedJob(supabase, job) {
  if (!DISPATCH_JOB_TYPES.has(job.type)) return false
  if (!isStuckApprovedJob(job)) return false

  if (await tasksAlreadyDispatchedForJob(supabase, job)) {
    console.log(`[worker] stuck job ${job.id} — tasks already sent, marking executed`)
    await callJobResult(job.id, 'success', { skipped: 'already_dispatched' })
    enqueuedIds.delete(job.id)
    stuckReenqueueCounts.delete(job.id)
    return true
  }

  const retries = (stuckReenqueueCounts.get(job.id) ?? 0) + 1
  stuckReenqueueCounts.set(job.id, retries)
  if (retries >= STUCK_MAX_REENQUEUES) {
    console.log(`[worker] stuck job ${job.id} — marking failed after ${retries} re-enqueues`)
    await callJobResult(job.id, 'failed', undefined, 'dispatch_stuck_max_retries')
    enqueuedIds.delete(job.id)
    stuckReenqueueCounts.delete(job.id)
    return true
  }

  console.log(`[worker] re-enqueueing stuck approved job ${job.id} (retry ${retries}/${STUCK_MAX_REENQUEUES})`)
  enqueuedIds.delete(job.id)
  return true
}

// ── Phase 6: Staff task dispatch queue ────────────────────────────────────────

const staffDispatchQueue = new Queue('staff-dispatch', {
  connection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
})

const csReplyQueue = new Queue('cs-reply', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 4000 } },
})

// Phase A: browser-agent tasks. The main worker only ENQUEUES here; the separate
// alma-browser-worker PM2 process (Playwright) consumes this queue so its memory
// footprint / crashes never take down the main worker.
const browserTaskQueue = new Queue('browser-task', {
  connection,
  defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 100 },
})

// ── Polling for new approved jobs ──────────────────────────────────────────

async function pollPendingJobs() {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/pending-jobs`, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.error(`[worker] pending-jobs poll failed: HTTP ${res.status}`)
      return
    }
    const { jobs } = await res.json()
    for (const job of jobs ?? []) {
      if (enqueuedIds.has(job.id)) {
        const reconciled = await reconcileStuckApprovedJob(supabase, job)
        if (!reconciled) continue
      }
      let handled = false
      if (job.type === 'image_gen') {
        await imageGenQueue.add('generate', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued image-gen job for action ${job.id}`)
        handled = true
      } else if (job.type === 'video_gen') {
        await videoGenQueue.add('generate', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued video-gen job for action ${job.id}`)
        handled = true
      } else if (job.type === 'video_edit') {
        await videoEditQueue.add('edit', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued video-edit job for action ${job.id}`)
        handled = true
      } else if (job.type === 'audio_gen') {
        await audioGenQueue.add('gen', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued audio-lab job for action ${job.id}`)
        handled = true
      } else if (job.type === 'video_finish') {
        await videoFinishQueue.add('finish', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued video-finish job for action ${job.id}`)
        handled = true
      } else if (job.type === 'long_agent_task') {
        await longTaskQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        handled = true
      } else if (job.type === 'workbench_run') {
        await workbenchQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued workbench task for action ${job.id}`)
        handled = true
      } else if (job.type === 'seo_audit') {
        await seoAuditQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued seo audit for action ${job.id}`)
        handled = true
      } else if (job.type === 'dispatch_staff_tasks' || job.type === 'add_staff_task_now' || job.type === 'staff_announcement') {
        await staffDispatchQueue.add('dispatch', { pendingActionId: job.id, payload: job.payload, type: job.type }, { jobId: job.id })
        console.log(`[worker] enqueued staff dispatch for action ${job.id}`)
        handled = true
      } else if (job.type === 'urgent_notify') {
        const { processUrgentNotify } = await import('./reminders/ticker.mjs')
        await processUrgentNotify(job.payload)
        await callJobResult(job.id, 'success', { ok: true })
        console.log(`[worker] urgent_notify dispatched for action ${job.id}`)
        handled = true
      } else if (job.type === 'outbound_call') {
        const { processOutboundCall } = await import('./reminders/ticker.mjs')
        try {
          const result = await processOutboundCall(job.payload)
          await callJobResult(job.id, 'success', { ok: true, callSid: result.callSid })
          console.log(`[worker] outbound_call completed for action ${job.id}`)
        } catch (err) {
          await callJobResult(job.id, 'failed', undefined, err.message)
          console.error(`[worker] outbound_call failed for action ${job.id}:`, err.message)
        }
        handled = true
      } else if (job.type === 'browser_action') {
        await browserTaskQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued browser task for action ${job.id}`)
        handled = true
      }

      if (!handled) {
        console.error(`[worker] unknown pending job type "${job.type}" for action ${job.id}`)
        await callJobResult(job.id, 'failed', undefined, `unknown_job_type:${job.type}`)
        continue
      }
      enqueuedIds.add(job.id)
    }
  } catch (err) {
    console.error('[worker] poll error:', err.message)
    captureWorkerError(err, 'worker.poll_pending_jobs')
  }
}

// ── Image generation handler ───────────────────────────────────────────────

// Default Gemini image models — owner can override per-tier via the
// `cs_image_models` kv setting ({"standard":"...","pro":"..."}) without a redeploy.
const DEFAULT_IMAGE_MODELS = {
  standard: 'gemini-3.1-flash-image',
  pro: 'gemini-3-pro-image',
}

async function fetchImageModels() {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', 'cs_image_models')
      .maybeSingle()
    if (!data?.value) return DEFAULT_IMAGE_MODELS
    const cfg = JSON.parse(data.value)
    return {
      standard: typeof cfg.standard === 'string' && cfg.standard.trim() ? cfg.standard.trim() : DEFAULT_IMAGE_MODELS.standard,
      pro: typeof cfg.pro === 'string' && cfg.pro.trim() ? cfg.pro.trim() : DEFAULT_IMAGE_MODELS.pro,
    }
  } catch {
    return DEFAULT_IMAGE_MODELS
  }
}

async function generateImageToStorage({
  pendingActionId,
  prompt,
  quality,
  referenceImageId,
  secondReferenceImageId,
  aspectRatio,
  imageSize,
  suffix = '',
  models,
}) {
  const resolvedModels = models ?? DEFAULT_IMAGE_MODELS
  const modelName = quality === 'standard' ? resolvedModels.standard : resolvedModels.pro

  const resolvedAspectRatio = aspectRatio ?? '4:5'
  const resolvedImageSize = imageSize ?? '2K'

  async function toInlinePart(path) {
    const { data: fileData, error: dlErr } = await supabase.storage.from('agent-files').download(path)
    if (dlErr || !fileData) return null
    const arrayBuffer = await fileData.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    return { inlineData: { mimeType: fileData.type || 'image/jpeg', data: base64 } }
  }

  const imageParts = []
  if (referenceImageId) {
    const p1 = await toInlinePart(referenceImageId)
    if (p1) imageParts.push(p1)
  }
  if (secondReferenceImageId) {
    const p2 = await toInlinePart(secondReferenceImageId)
    if (p2) imageParts.push(p2)
  }

  const contents = imageParts.length ? [...imageParts, { text: prompt }] : [{ text: prompt }]

  const response = await genai.models.generateContent({
    model: modelName,
    contents,
    config: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: resolvedAspectRatio,
        imageSize: resolvedImageSize,
      },
    },
  })

  const parts = response?.candidates?.[0]?.content?.parts ?? []
  let imageBase64 = null
  let imageMimeType = 'image/png'

  for (const part of parts) {
    if (part.inlineData?.data) {
      imageBase64 = part.inlineData.data
      imageMimeType = part.inlineData.mimeType || 'image/png'
      break
    }
  }

  if (!imageBase64) throw new Error('No image in Gemini response')

  const ext = imageMimeType.split('/')[1] || 'png'
  const storagePath = suffix
    ? `generated/${pendingActionId}-${suffix}.${ext}`
    : `generated/${pendingActionId}.${ext}`
  const imageBuffer = Buffer.from(imageBase64, 'base64')

  const { error: uploadErr } = await supabase
    .storage
    .from('agent-files')
    .upload(storagePath, imageBuffer, { contentType: imageMimeType, upsert: true })

  if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`)

  return { storagePath, modelName, quality, resolvedAspectRatio, resolvedImageSize }
}

async function processImageGen(job) {
  const { pendingActionId, payload } = job.data
  console.log(`[worker] image-gen ${pendingActionId} — starting`)

  if (!payload) {
    await callJobResult(pendingActionId, 'failed', undefined, 'No payload in job data')
    return
  }

  if (payload.provider === 'fashn') {
    try {
      const { processFashnImageGen } = await import('./fashn/process.mjs')
      const { logCost } = await import('./cost-log.mjs')
      const result = await processFashnImageGen({ supabase, pendingActionId, payload, logCost })
      const { postProcessImage } = await import('./cs/branding.mjs')
      // Only a fast gallery thumbnail here — branding (logo + code + hook) is an
      // on-demand, per-image step the owner runs from the Studio, not auto-stamped.
      const finishing = await postProcessImage(supabase, pendingActionId, result.storagePath)
      await callJobResult(pendingActionId, 'success', {
        storagePath: result.storagePath,
        allPaths: result.allPaths,
        provider: 'fashn',
        creativeStudio: true,
        studioMode: payload.studioMode,
        qc: result.qc ?? undefined,
        ...finishing,
      })
      console.log(`[worker] fashn ${pendingActionId} — done → ${result.storagePath}`)
    } catch (err) {
      await callJobResult(pendingActionId, 'failed', undefined, err.message)
      console.error(`[worker] fashn ${pendingActionId} — failed:`, err.message)
    }
    return
  }

  const {
    prompt: basePrompt,
    quality,
    referenceImageId,
    secondReferenceImageId,
    conversationId,
    aspectRatio,
    imageSize,
    contentPipeline,
  } = payload

  const { fetchQcLevel, runImageQcLoop } = await import('./image-qc.mjs')
  const qcLevel = await fetchQcLevel(supabase)
  const imageModels = await fetchImageModels()

  const genOpts = {
    pendingActionId,
    quality,
    referenceImageId,
    secondReferenceImageId,
    aspectRatio,
    imageSize,
    models: imageModels,
  }

  const { logCost, calcGeminiImageCostUsd } = await import('./cost-log.mjs')

  async function logImageCost(storagePath, modelName, resolvedAspectRatio, resolvedImageSize, qcAttempt) {
    void logCost({
      provider: 'gemini',
      kind: 'image',
      units: {
        quality,
        model: modelName,
        aspectRatio: resolvedAspectRatio,
        imageSize: resolvedImageSize,
        pendingActionId,
        qcAttempt,
      },
      costUsd: calcGeminiImageCostUsd(quality === 'standard' ? 'standard' : 'pro', resolvedImageSize),
      conversationId: conversationId ?? undefined,
      jobId: pendingActionId,
      dedupKey: `image:${pendingActionId}:${qcAttempt ?? 1}`,
    })
  }

  const first = await generateImageToStorage({ ...genOpts, prompt: basePrompt })
  await logImageCost(first.storagePath, first.modelName, first.resolvedAspectRatio, first.resolvedImageSize, 1)
  console.log(`[worker] image-gen ${pendingActionId} — gen attempt 1 → ${first.storagePath}`)

  const productType = contentPipeline?.productCode ?? null
  const productImagePath = secondReferenceImageId ?? null

  let regenCount = 0
  const qcResult = await runImageQcLoop({
    supabase,
    appUrl: getAppUrl(),
    token: getInternalToken(),
    qcLevel,
    initialPath: first.storagePath,
    productType,
    productImagePath,
    regenerate: async (fixHint, attemptNum) => {
      regenCount += 1
      const regenPrompt = `${basePrompt}\n\nQC FIX (regeneration attempt ${attemptNum}): ${fixHint}`
      const regen = await generateImageToStorage({
        ...genOpts,
        prompt: regenPrompt,
        suffix: `qc${attemptNum}`,
      })
      await logImageCost(regen.storagePath, regen.modelName, regen.resolvedAspectRatio, regen.resolvedImageSize, attemptNum)
      console.log(`[worker] image-gen ${pendingActionId} — QC regen ${attemptNum} → ${regen.storagePath}`)
      return regen.storagePath
    },
  })

  if (qcResult.qc?.scores?.length) {
    console.log(`[worker] image-gen ${pendingActionId} — QC`, JSON.stringify(qcResult.qc))
  }

  const { postProcessImage } = await import('./cs/branding.mjs')
  // Only a fast gallery thumbnail here — branding (logo + code + hook) is an
  // on-demand, per-image step the owner runs from the Studio, not auto-stamped.
  const finishing = await postProcessImage(supabase, pendingActionId, qcResult.storagePath)

  await callJobResult(pendingActionId, 'success', {
    storagePath: qcResult.storagePath,
    conversationId,
    qc: qcResult.qc,
    ...finishing,
  })

  console.log(`[worker] image-gen ${pendingActionId} — done → ${qcResult.storagePath}${qcResult.qc?.flagged ? ` (${qcResult.qc.flagged})` : ''}`)
}

// ── Video generation handler (Veo 3.1) — see video-gen.mjs ───────────────────

// ── Callback ───────────────────────────────────────────────────────────────

const MAX_JOB_RESULT_RETRIES = 3

async function callJobResult(pendingActionId, status, data, error, attempt = 0) {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/job-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ pendingActionId, status, data, error }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[worker] job-result callback HTTP ${res.status}: ${body.slice(0, 200)}`)
      if (attempt + 1 < MAX_JOB_RESULT_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        return callJobResult(pendingActionId, status, data, error, attempt + 1)
      }
    }
  } catch (err) {
    console.error('[worker] job-result callback error:', err.message)
    if (attempt + 1 < MAX_JOB_RESULT_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      return callJobResult(pendingActionId, status, data, error, attempt + 1)
    }
  }
}

// ── Workers ────────────────────────────────────────────────────────────────

const imageGenWorker = new Worker('image-gen', processImageGen, {
  connection,
  concurrency: 2,
})

const videoGenWorker = new Worker(
  'video-gen',
  (job) => processVideoGen(job, { supabase, genai, callJobResult }),
  {
    connection,
    concurrency: 1,
    lockDuration: 15 * 60 * 1000,
  },
)

// Phase V1: ffmpeg reel editing — CPU-bound, one at a time; a 2-min 500 MB
// source can take several minutes to transcode, so the lock is generous.
const videoEditWorker = new Worker(
  'video-edit',
  (job) => processVideoEdit(job, { supabase, callJobResult }),
  {
    connection,
    concurrency: 1,
    lockDuration: 30 * 60 * 1000,
  },
)

// Phase V3: Remotion render + ffmpeg composite — heavy, strictly one at a time.
const videoFinishWorker = new Worker(
  'video-finish',
  async (job) => {
    const { processVideoFinish } = await import('./video-finish.mjs')
    return processVideoFinish(job, { supabase, callJobResult })
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 30 * 60 * 1000,
  },
)

// Pre-warm Chrome Headless Shell + the Remotion bundle so the owner's first
// finish job doesn't pay the cold start. Best-effort, fully async.
setTimeout(() => {
  import('./video-finish.mjs')
    .then(({ videoFinishPreflight }) => videoFinishPreflight())
    .catch((err) => console.warn('[worker] video-finish preflight failed (first job will retry):', err?.message))
}, 30_000)

// E1: Audio Lab worker (ElevenLabs API calls — light, but keep it serial).
const audioGenWorker = new Worker(
  'audio-gen',
  async (job) => {
    const { processAudioGen } = await import('./audio-lab.mjs')
    return processAudioGen(job, { supabase, callJobResult })
  },
  { connection, concurrency: 1, lockDuration: 10 * 60 * 1000 },
)
audioGenWorker.on('completed', (job) => {
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
audioGenWorker.on('failed', async (job, err) => {
  console.error(`[worker] audio-lab ${job?.id} failed:`, err.message)
  if (job && job.attemptsMade < (job.opts?.attempts ?? 1)) return
  captureWorkerError(err, 'worker.audio_gen.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

// ── P2 workbench worker ─────────────────────────────────────────────────────
const workbenchWorker = new Worker(
  'workbench',
  async (job) => {
    const { pendingActionId, payload } = job.data
    try {
      const { runWorkbenchTask } = await import('./workbench/executor.mjs')
      const result = await runWorkbenchTask({ ...payload, taskId: pendingActionId })

      // Publish requested artifacts (workspace-relative paths) to agent storage
      // so the head/owner can open them; capped, best-effort.
      const artifactPaths = []
      const wanted = Array.isArray(payload?.artifacts) ? payload.artifacts.slice(0, 10) : []
      if (result.ok && wanted.length) {
        const { readFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        for (const rel of wanted) {
          const clean = String(rel).replace(/^\/+/, '')
          if (!clean || clean.includes('..')) continue
          try {
            const buf = await readFile(join(result.workspace, clean))
            if (buf.length > 20 * 1024 * 1024) continue
            const storagePath = `workbench/${pendingActionId}/${clean.replace(/\//g, '_')}`
            await supabase.storage.from('agent-files').upload(storagePath, buf, { upsert: true })
            artifactPaths.push(storagePath)
          } catch {
            /* artifact missing — the steps log tells the story */
          }
        }
        // Uploads done — now reclaim the workspace the executor kept for us
        // (it skips its own success-cleanup when artifacts are requested).
        if (!payload?.keepWorkspace) {
          const { rm } = await import('node:fs/promises')
          await rm(result.workspace, { recursive: true, force: true }).catch(() => {})
        }
      }

      if (result.ok) {
        await callJobResult(pendingActionId, 'success', {
          steps: result.steps,
          artifacts: artifactPaths,
        })
        console.log(`[worker] workbench ${pendingActionId} done (${result.steps.length} steps, ${artifactPaths.length} artifacts)`)
      } else {
        await callJobResult(pendingActionId, 'failed', { steps: result.steps }, result.error ?? 'workbench_failed')
        console.warn(`[worker] workbench ${pendingActionId} failed: ${result.error}`)
      }
    } catch (err) {
      captureWorkerError(err, 'worker.workbench.failed', { jobId: job?.id })
      await callJobResult(pendingActionId, 'failed', undefined, err.message ?? 'workbench_crashed')
    }
  },
  { connection, concurrency: 1 },
)
workbenchWorker.on('failed', (job, err) => {
  console.error(`[worker] workbench job ${job?.id} failed:`, err?.message)
})

// ── Client-SEO audit worker ──────────────────────────────────────────────────
const seoAuditWorker = new Worker(
  'seo-audit',
  async (job) => {
    const { pendingActionId, payload } = job.data
    try {
      const { runSeoAudit } = await import('./seo/audit.mjs')
      const result = await runSeoAudit(payload)
      if (!result.ok) {
        await callJobResult(pendingActionId, 'failed', undefined, result.error ?? 'seo_audit_failed')
        console.warn(`[worker] seo-audit ${pendingActionId} failed: ${result.error}`)
        return
      }
      // Publish the report (markdown) + full findings (json) as artifacts.
      const base = `seo-audits/${pendingActionId}`
      const artifacts = []
      try {
        await supabase.storage
          .from('agent-files')
          .upload(`${base}/report.md`, Buffer.from(result.reportMarkdown, 'utf8'), { upsert: true, contentType: 'text/markdown' })
        artifacts.push(`${base}/report.md`)
        await supabase.storage
          .from('agent-files')
          .upload(`${base}/audit.json`, Buffer.from(JSON.stringify(result.auditJson), 'utf8'), { upsert: true, contentType: 'application/json' })
        artifacts.push(`${base}/audit.json`)
      } catch (upErr) {
        // Report built but upload failed → NOT success (never claim done without the proof).
        await callJobResult(pendingActionId, 'failed', { score: result.score }, `artifact upload failed: ${upErr.message}`)
        return
      }
      await callJobResult(pendingActionId, 'success', {
        score: result.score,
        counts: result.counts,
        pagesCrawled: result.pagesCrawled,
        avgTtfbMs: result.avgTtfbMs,
        artifacts,
        reportPreview: result.reportMarkdown.slice(0, 1500),
      })
      console.log(`[worker] seo-audit ${pendingActionId} done — score ${result.score}, ${result.pagesCrawled} pages`)
    } catch (err) {
      captureWorkerError(err, 'worker.seo_audit.failed', { jobId: job?.id })
      await callJobResult(pendingActionId, 'failed', undefined, err.message ?? 'seo_audit_crashed')
    }
  },
  { connection, concurrency: 1, lockDuration: 10 * 60 * 1000 },
)
seoAuditWorker.on('failed', (job, err) => {
  console.error(`[worker] seo-audit job ${job?.id} failed:`, err?.message)
})

// Startup preflight: create WORKBENCH_ROOT + survey allowlisted binaries (the
// VPS has no inbound SSH — provisioning ships through the repo, pull-deployed).
try {
  const { workbenchPreflight } = await import('./workbench/executor.mjs')
  const pre = await workbenchPreflight()
  if (pre.missing.length) {
    console.warn(`[worker] workbench preflight: MISSING binaries on this box: ${pre.missing.join(', ')} (root ${pre.root})`)
  } else {
    console.log(`[worker] workbench preflight OK — root ${pre.root}, all allowlisted binaries present`)
  }
} catch (err) {
  console.error('[worker] workbench preflight error:', err.message)
}

// Workspace janitor: failed/kept workspaces are retained for diagnosis; this
// sweep reclaims them after WORKBENCH_KEEP_DAYS (default 7). Startup + every 6h.
async function sweepWorkbenchWorkspaces() {
  try {
    const { cleanupWorkspaces } = await import('./workbench/executor.mjs')
    const { removed, kept } = await cleanupWorkspaces()
    if (removed > 0) console.log(`[worker] workbench janitor: removed ${removed} old workspaces (${kept} kept)`)
  } catch (err) {
    console.error('[worker] workbench janitor error:', err.message)
  }
}
await sweepWorkbenchWorkspaces()
const workbenchJanitorInterval = setInterval(sweepWorkbenchWorkspaces, 6 * 60 * 60 * 1000)

const longTaskWorker = new Worker('long-agent-task', async (job) => {
  // A2: owner web turn enqueued by /api/assistant/turn. Identified by turnId.
  // Runs the turn via the chat route in stream mode and republishes events to
  // Redis + the agent_turn_events log so the client can tail/replay it.
  if (job.data?.turnId) {
    const { runStreamedTurn } = await import('./turn/run-streamed-turn.mjs')
    await runStreamedTurn({ supabase, job, redisUrl: LONG_TASK_REDIS_URL, telegramBot })
    return
  }

  const { pendingActionId, payload } = job.data
  const taskPrompt = payload?.prompt || payload?.task || payload?.message
  if (!taskPrompt) {
    console.warn(`[worker] long-agent-task ${job.id} — no prompt in payload`)
    // Only report back when there is a pendingActionId to report against — otherwise
    // the job-result route rejects the call with HTTP 400 ("pendingActionId and status
    // required"), which is what was spamming the worker error log.
    if (pendingActionId) {
      await callJobResult(pendingActionId, 'failed', undefined, 'no_prompt_in_payload')
    }
    return
  }
  console.log(`[worker] long-agent-task ${pendingActionId} starting: ${String(taskPrompt).slice(0, 80)}...`)
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/chat?stream=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: taskPrompt }],
        systemOverride: payload?.systemOverride,
        tools: payload?.tools,
      }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => 'no body')
      throw new Error(`chat API ${res.status}: ${text.slice(0, 200)}`)
    }
    const result = await res.json()
    await callJobResult(pendingActionId, 'success', {
      response: result.content || result.text || result,
    })
    console.log(`[worker] long-agent-task ${pendingActionId} — done`)
  } catch (err) {
    console.error(`[worker] long-agent-task ${pendingActionId} failed:`, err.message)
    await callJobResult(pendingActionId, 'failed', undefined, err.message)
  }
}, { connection: longTaskConnection, concurrency: 1, lockDuration: 6 * 60 * 1000 })

longTaskWorker.on('completed', (job) => {
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
longTaskWorker.on('failed', async (job, err) => {
  console.error(`[worker] long-agent-task ${job?.id} failed:`, err.message)
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message).catch((e) => {
      console.warn('[worker] callJobResult(failed) failed:', e.message)
    })
  }
})

// ── Staff dispatch worker ──────────────────────────────────────────────────────

const staffDispatchWorker = new Worker('staff-dispatch', async (job) => {
  const { payload, type } = job.data
  const bot = telegramBot

  if (!bot) {
    throw new Error('Telegram bot not ready for staff dispatch')
  }

  if (type === 'dispatch_staff_tasks') {
    const { date, taskIds } = payload ?? {}
    try {
      const dispatchResult = await dispatchTasksToStaff({ supabase, bot, date, taskIds })
      await callJobResult(job.data.pendingActionId, 'success', dispatchResult ?? { dispatched: taskIds?.length ?? 0 })
    } catch (err) {
      console.error('[worker] dispatch failed:', err.message)
      await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
      const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
      if (ownerChatId && bot) {
        await bot.telegram.sendMessage(
          ownerChatId,
          `❌ Task dispatch ব্যর্থ: ${err.message?.slice(0, 150)}। আবার চেষ্টা করুন।`,
        ).catch((e) => {
          console.warn('[worker] dispatch fail notify failed:', e.message)
        })
      }
    }

  } else if (type === 'add_staff_task_now') {
    const { staffId, date, taskId } = payload ?? {}
    let taskIds = taskId ? [taskId] : []
    if (!taskIds.length && staffId && date) {
      const { data: tasks } = await supabase
        .from('staff_tasks')
        .select('id')
        .eq('staff_id', staffId)
        .eq('proposed_for', date)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(1)
      taskIds = tasks?.map(t => t.id) ?? []
    }

    let dispatchResult = null
    if (taskIds.length) {
      dispatchResult = await dispatchTasksToStaff({ supabase, bot, date, taskIds })
    } else {
      console.warn('[worker] add_staff_task_now: no approved task found to dispatch', payload)
    }
    await callJobResult(job.data.pendingActionId, 'success', dispatchResult ?? { dispatched: 0, skipped: true })

  } else if (type === 'staff_announcement') {
    const result = await sendStaffAnnouncement({ bot, payload })
    await callJobResult(job.data.pendingActionId, 'success', result)
  }
}, { connection, concurrency: 1 })

const agentTurnWorker = new Worker('agent-turn', async (job) => {
  await deliverAgentTurn(job.data)
}, { connection, concurrency: 1 })

agentTurnWorker.on('failed', (job, err) => {
  console.error(`[worker] agent-turn ${job?.id} failed:`, err.message)
  captureWorkerError(err, 'worker.agent_turn.failed', { jobId: job?.id })
})

staffDispatchWorker.on('completed', (job) => {
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
staffDispatchWorker.on('failed', async (job, err) => {
  console.error(`[worker] staff-dispatch ${job?.id} failed:`, err.message)
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message).catch((e) => {
      console.warn('[worker] dispatch callJobResult(failed) failed:', e.message)
    })
    const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
    if (ownerChatId && telegramBot) {
      await telegramBot.telegram.sendMessage(
        ownerChatId,
        `❌ Task dispatch ব্যর্থ: ${err.message?.slice(0, 150)}। আবার চেষ্টা করুন।`,
      ).catch((e) => {
        console.warn('[worker] dispatch fail notify failed:', e.message)
      })
    }
  }
})

imageGenWorker.on('completed', (job) => {
  console.log(`[worker] image-gen ${job.id} completed`)
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
imageGenWorker.on('failed', async (job, err) => {
  console.error(`[worker] image-gen ${job?.id} failed:`, err.message)
  captureWorkerError(err, 'worker.image_gen.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

videoGenWorker.on('completed', (job) => {
  console.log(`[worker] video-gen ${job.id} completed`)
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
videoGenWorker.on('failed', async (job, err) => {
  console.error(`[worker] video-gen ${job?.id} failed:`, err.message)
  captureWorkerError(err, 'worker.video_gen.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

videoEditWorker.on('completed', (job) => {
  console.log(`[worker] video-edit ${job.id} completed`)
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
videoEditWorker.on('failed', async (job, err) => {
  console.error(`[worker] video-edit ${job?.id} failed:`, err.message)
  // BullMQ retries first (attempts:2); only the FINAL failure reaches the app.
  if (job && job.attemptsMade < (job.opts?.attempts ?? 1)) return
  captureWorkerError(err, 'worker.video_edit.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

videoFinishWorker.on('completed', (job) => {
  console.log(`[worker] video-finish ${job.id} completed`)
  if (job?.data?.pendingActionId) enqueuedIds.delete(job.data.pendingActionId)
})
videoFinishWorker.on('failed', async (job, err) => {
  console.error(`[worker] video-finish ${job?.id} failed:`, err.message)
  if (job && job.attemptsMade < (job.opts?.attempts ?? 1)) return
  captureWorkerError(err, 'worker.video_finish.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

// ── Telegram bot (singleton — one getUpdates poller per process) ───────────

let telegramBot = null

if (process.env.ASSISTANT_BOT_TOKEN) {
  try {
    telegramBot = await launchTelegramBot()
    await loadOwnerStateFromKv(supabase).catch((err) =>
      console.warn('[owner-state] startup load failed:', err.message),
    )
    await hydrateAwaitingProof(supabase).catch((err) =>
      console.warn('[task-verification] hydrate failed:', err.message),
    )
  } catch (err) {
    console.error('‼️ [telegram] CRITICAL — Bot launch failed, worker running WITHOUT Telegram:', err.message)
    captureWorkerError(err, 'worker.telegram_boot_failed')
    // ntfy alert so owner knows bot is down
    import('./notify/ntfy.mjs').then(({ sendNtfy }) =>
      sendNtfy('critical', 'Telegram bot down', `Worker started but Telegram bot failed: ${err.message}`, 'urgent')
    ).catch((e) => {
      console.error('[worker] CRITICAL: ntfy alert for bot failure also failed:', e.message)
    })
  }
} else {
  console.warn('[worker] ASSISTANT_BOT_TOKEN not set — Telegram bot disabled')
}

// ── Phase 6: Schedulers ────────────────────────────────────────────────────

let schedulerQueue = null
let runSchedulerJobFn = null
let schedulerTeardown = null
try {
  const schedulerSetup = await setupSchedulers({
    connection,
    supabase,
    bot: telegramBot,
  })
  schedulerTeardown = schedulerSetup
  schedulerQueue = schedulerSetup?.schedulerQueue ?? null
  runSchedulerJobFn = schedulerSetup?.runSchedulerJob ?? null
  if (schedulerQueue) {
    // Initialize today's salah records on startup (idempotent)
    await initializeDailySalahRecords(supabase).catch(err =>
      console.error('[salah] init failed:', err.message)
    )
    // Catch-up missed critical duties after worker was down (silent — no Telegram spam on restart)
    if (runSchedulerJobFn) {
      setTimeout(() => {
        import('./schedulers/catchup.mjs')
          .then(({ runCatchup }) =>
            runCatchup({
              supabase,
              bot: telegramBot,
              runJob: (name, opts) => runSchedulerJobFn(name, opts),
              opts: { notifyOwner: false, source: 'startup' },
            }),
          )
          .catch((e) => console.error('[catchup] startup:', e.message))
      }, 30_000)
    }
  }
} catch (err) {
  console.error('[schedulers] setup error:', err.message)
}

// ── Start polling ──────────────────────────────────────────────────────────

await pollPendingJobs()
// Poll cadence is env-tunable to relieve Supabase connection pressure (each poll
// hits a Prisma endpoint on Vercel). Floors guard against accidental hammering.
const PENDING_JOBS_POLL_MS = Math.max(15_000, Number(process.env.WORKER_PENDING_JOBS_POLL_MS) || 30_000)
const pollInterval = setInterval(pollPendingJobs, PENDING_JOBS_POLL_MS)

const { pollCsPendingReplies } = await import('./cs/reply.mjs')
const csEnqueued = new Set()

async function pollAndEnqueueCsReplies() {
  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/internal/cs-pending-replies`, {
      headers: { Authorization: `Bearer ${getInternalToken()}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return
    const { jobs } = await res.json()
    for (const job of jobs ?? []) {
      if (csEnqueued.has(job.id)) continue
      csEnqueued.add(job.id)
      await csReplyQueue.add('reply', job, { jobId: job.id })
    }
  } catch (err) {
    console.error('[cs-reply] enqueue poll error:', err.message)
  }
}

const csReplyWorker = new Worker('cs-reply', async (job) => {
  const { processCsReplyJob } = await import('./cs/reply.mjs')
  await processCsReplyJob(job.data, telegramBot)
}, { connection, concurrency: 2 })

csReplyWorker.on('completed', (job) => {
  if (job?.id) csEnqueued.delete(job.id)
})
csReplyWorker.on('failed', (job, err) => {
  console.error(`[cs-reply] ${job?.id} failed:`, err.message)
  if (job?.id) csEnqueued.delete(job.id)
})

await pollAndEnqueueCsReplies()
// Was a fixed 10s — the dominant DB-load source in the connection-exhaustion
// incident. Default 30s (3× less load); tune via WORKER_CS_POLL_MS, floor 15s.
const CS_POLL_MS = Math.max(15_000, Number(process.env.WORKER_CS_POLL_MS) || 30_000)
const csPollInterval = setInterval(pollAndEnqueueCsReplies, CS_POLL_MS)

const { pollMessengerInbox } = await import('./cs/messenger-poll.mjs')
await pollMessengerInbox().catch((err) => console.error('[cs-messenger-poll] startup error:', err.message))
const csMessengerPollInterval = setInterval(() => {
  pollMessengerInbox().catch((err) => console.error('[cs-messenger-poll] error:', err.message))
}, 60_000)

const heartbeatInterval = startHeartbeatLoop({
  hasTelegram: Boolean(process.env.ASSISTANT_BOT_TOKEN),
  hasSchedulers: Boolean(schedulerQueue),
})
const healthPingInterval = startHealthPingLoop()

startTwilioHttpServer()
if (runSchedulerJobFn) setRetriggerHandler(runSchedulerJobFn)
startDiagnosticHttpServer()

// Two-way ConversationRelay bridge (Google Charon voice) — only when configured.
if (process.env.VOICE_CALL_PROVIDER === 'relay') {
  const { startVoiceRelayServer } = await import('./voice-relay/server.mjs')
  startVoiceRelayServer()
}

console.log('[worker] ALMA Agent Worker started — polling every 30s for approved jobs')

let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[worker] ${signal} — draining...`)
  clearInterval(pollInterval)
  clearInterval(csPollInterval)
  clearInterval(csMessengerPollInterval)
  clearInterval(heartbeatInterval)
  clearInterval(healthPingInterval)
  clearInterval(workbenchJanitorInterval)
  if (schedulerTeardown?.retriggerPoll) clearInterval(schedulerTeardown.retriggerPoll)
  if (schedulerTeardown?.dutyTimePoll) clearInterval(schedulerTeardown.dutyTimePoll)
  await stopTelegramBot(signal)
  await Promise.all([
    imageGenWorker.close(),
    videoGenWorker.close(),
    longTaskWorker.close(),
    workbenchWorker.close(),
    seoAuditWorker.close(),
    staffDispatchWorker.close(),
    csReplyWorker.close(),
    schedulerTeardown?.schedulerWorker?.close(),
  ])
  process.exit(0)
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

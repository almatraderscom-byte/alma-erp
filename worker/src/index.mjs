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

// Phase 35: durable specialist fan-out jobs (>30s). attempts:3 — the runner
// checkpoints after every brief, so a retry RESUMES (completed-set skip),
// never duplicates work.
const agentGraphQueue = new Queue('agent-graph-run', {
  connection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
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
      } else if (job.type === 'agent_graph_run') {
        // Phase 35: durable multi-specialist fan-out (>30s work). jobId =
        // pendingActionId → BullMQ dedupes duplicate deliveries at the queue.
        await agentGraphQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued agent-graph-run for action ${job.id}`)
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

  // ── Seedream engine (owner-switchable via cs_image_models → "seedream-5.0-pro") ──
  // ByteDance Seedream 5.0 Pro via fal.ai (verdict 2026-07-12: the only genuine
  // Nano-Banana challenger — 2K detail + strong text). Reference images go
  // through /edit (data-URI inputs), fresh prompts through /text-to-image; the
  // returned image URL is fetched and landed in the same storage path shape so
  // the rest of the pipeline stays engine-blind.
  if (modelName.startsWith('seedream')) {
    const key = process.env.FAL_KEY
    if (!key) throw new Error('FAL_KEY missing on worker — Seedream engine unavailable (env-set it, or switch cs_image_models back to Gemini)')
    const ratio = /^\d+:\d+$/.test(resolvedAspectRatio) ? resolvedAspectRatio : '4:5'
    const [rw, rh] = ratio.split(':').map(Number)
    // standard stays in fal's cheaper ≤1536px band; pro renders the 2K tier.
    const maxSide = quality === 'standard' ? 1536 : 2048
    const scale = maxSide / Math.max(rw, rh)
    const width = Math.max(512, Math.round((rw * scale) / 32) * 32)
    const height = Math.max(512, Math.round((rh * scale) / 32) * 32)
    const endpoint = imageParts.length
      ? 'https://fal.run/bytedance/seedream/v5/pro/edit'
      : 'https://fal.run/bytedance/seedream/v5/pro/text-to-image'
    const body = imageParts.length
      ? {
          prompt,
          image_urls: imageParts.map((p) => `data:${p.inlineData.mimeType || 'image/png'};base64,${p.inlineData.data}`),
          image_size: { width, height },
        }
      : { prompt, image_size: { width, height } }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Seedream (fal) ${res.status}: ${errBody.slice(0, 300)}`)
    }
    const json = await res.json()
    const url = json?.images?.[0]?.url
    if (!url) throw new Error('No image in Seedream response')
    const imgRes = await fetch(url)
    if (!imgRes.ok) throw new Error(`Seedream image download ${imgRes.status}`)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    const contentType = imgRes.headers.get('content-type') || 'image/png'
    const ext = contentType.includes('jpeg') ? 'jpg' : 'png'
    const storagePath = suffix
      ? `generated/${pendingActionId}-${suffix}.${ext}`
      : `generated/${pendingActionId}.${ext}`
    const { error: uploadErr } = await supabase
      .storage
      .from('agent-files')
      .upload(storagePath, buf, { contentType, upsert: true })
    if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`)
    return { storagePath, modelName, quality, resolvedAspectRatio, resolvedImageSize }
  }

  // ── OpenAI engine (owner-switchable via cs_image_models → "gpt-image-2") ──
  // Verdict 2026-07-12: GPT Image 2 wins text-in-image + speed; Nano Banana
  // stays the photorealism/face default. References go through /images/edits
  // (multi-image), fresh prompts through /images/generations; output lands in
  // the same storage path shape so the rest of the pipeline is engine-blind.
  if (modelName.startsWith('gpt-image')) {
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY missing on worker — GPT image engine unavailable (env-set it, or switch cs_image_models back to Gemini)')
    const portrait = ['9:16', '3:4', '4:5', '2:3'].includes(resolvedAspectRatio)
    const landscape = ['16:9', '4:3', '5:4', '3:2'].includes(resolvedAspectRatio)
    const size = portrait ? '1024x1536' : landscape ? '1536x1024' : '1024x1024'
    const gptQuality = quality === 'standard' ? 'medium' : 'high'
    let res
    if (imageParts.length) {
      const form = new FormData()
      form.append('model', modelName)
      form.append('prompt', prompt)
      form.append('size', size)
      form.append('quality', gptQuality)
      imageParts.forEach((part, i) => {
        const buf = Buffer.from(part.inlineData.data, 'base64')
        form.append('image[]', new Blob([buf], { type: part.inlineData.mimeType || 'image/png' }), `ref-${i}.png`)
      })
      res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      })
    } else {
      res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, prompt, size, quality: gptQuality }),
      })
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`OpenAI image ${res.status}: ${errBody.slice(0, 300)}`)
    }
    const json = await res.json()
    const b64 = json?.data?.[0]?.b64_json
    if (!b64) throw new Error('No image in OpenAI response')
    const storagePath = suffix
      ? `generated/${pendingActionId}-${suffix}.png`
      : `generated/${pendingActionId}.png`
    const { error: uploadErr } = await supabase
      .storage
      .from('agent-files')
      .upload(storagePath, Buffer.from(b64, 'base64'), { contentType: 'image/png', upsert: true })
    if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`)
    return { storagePath, modelName, quality, resolvedAspectRatio, resolvedImageSize }
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

  // Supplier-photo garment prep (free local segmentation): split the reseller
  // photo into per-person crops; the chain uses the REAL adult/child pieces.
  if (payload.provider === 'garment_prep') {
    try {
      const { prepSupplierPhoto } = await import('./garment-prep.mjs')
      const result = await prepSupplierPhoto({ supabase, imagePath: payload.imagePath })
      await callJobResult(pendingActionId, 'success', {
        garmentPrep: true,
        multiPerson: result.multiPerson,
        persons: result.persons,
        adultGarmentPath: result.adultGarmentPath,
        childGarmentPath: result.childGarmentPath,
        creativeStudio: false,
      })
      console.log(`[worker] garment-prep ${pendingActionId} — ${result.persons.length} crop(s)`)
    } catch (err) {
      await callJobResult(pendingActionId, 'failed', undefined, err.message)
      console.error(`[worker] garment-prep ${pendingActionId} — failed:`, err.message)
    }
    return
  }

  // CS10 — golden-set engine evaluation (owner-triggered, bounded, resumable).
  if (payload.provider === 'golden_eval') {
    try {
      const { runGoldenEval } = await import('../scripts/run-creative-studio-golden-eval.mjs')
      const { logCost } = await import('./cost-log.mjs')
      const { getAppUrl, getInternalToken } = await import('./env.mjs')
      const report = await runGoldenEval({
        supabase,
        pendingActionId,
        payload,
        logCost,
        appUrl: getAppUrl(),
        token: getInternalToken(),
      })
      await callJobResult(pendingActionId, 'success', {
        goldenEval: true,
        runId: report.runId,
        attempts: report.attempts.length,
        totalCostUsd: report.totalCostUsd,
        creativeStudio: false,
      })
      console.log(`[worker] golden-eval ${report.runId} — done, ${report.attempts.length} attempts, $${report.totalCostUsd}`)
    } catch (err) {
      await callJobResult(pendingActionId, 'failed', undefined, err.message)
      console.error(`[worker] golden-eval failed:`, err.message)
    }
    return
  }

  // CS9 — protected family composite: local segmentation + deterministic
  // layout, NO face/garment regeneration; fal used only to harmonize seams.
  if (payload.provider === 'family_composite') {
    try {
      const { processFamilyComposite } = await import('./family-composite.mjs')
      const { logCost } = await import('./cost-log.mjs')
      const result = await processFamilyComposite({ supabase, pendingActionId, payload, logCost })
      const { postProcessImage } = await import('./cs/branding.mjs')
      const finishing = await postProcessImage(supabase, pendingActionId, result.storagePath)
      await callJobResult(pendingActionId, 'success', {
        storagePath: result.storagePath,
        allPaths: result.allPaths,
        provider: 'family_composite',
        protectedComposite: true,
        variant: result.variant,
        insertRole: result.insertRole,
        memberCount: result.memberCount,
        expectedMembers: result.expectedMembers,
        harmonize: result.harmonize,
        requestId: result.harmonize?.requestId,
        latencyMs: result.harmonize?.latencyMs,
        costUsd: result.harmonize?.costUsd ?? 0,
        creativeStudio: true,
        studioMode: payload.studioMode,
        ...finishing,
      })
      console.log(`[worker] family-composite ${pendingActionId} — done → ${result.storagePath}`)
    } catch (err) {
      await callJobResult(pendingActionId, 'failed', undefined, err.message)
      console.error(`[worker] family-composite ${pendingActionId} — failed:`, err.message)
    }
    return
  }

  // CS6 — Fal-backed single-person VTON engines (owner-selected). Durable queue
  // client inside the adapters; result metadata is the truthful lineage the
  // Gallery shows (engine, request id, seed, latency, cost).
  if (payload.provider === 'fal') {
    try {
      // CS12 — owner kill switch: refuse jobs on a killed engine, clearly.
      const { isEngineKilled } = await import('./fal/client.mjs')
      if (await isEngineKilled(supabase, payload.falEngine)) {
        await callJobResult(pendingActionId, 'failed', undefined, `ইঞ্জিনটি kill switch দিয়ে বন্ধ করা আছে (${payload.falEngine}) — সেটিংস থেকে চালু করে আবার চালান।`)
        return
      }
      const adapter = payload.falEngine === 'fal_idm_vton'
        ? await import('./fal/adapters/cat-vton.mjs')
        : payload.falEngine === 'fal_flux_fill'
          ? await import('./fal/adapters/flux-fill.mjs')
          : await import('./fal/adapters/fashn-v16.mjs')
      const process = payload.falEngine === 'fal_idm_vton'
        ? adapter.processCatVton
        : payload.falEngine === 'fal_flux_fill'
          ? adapter.processFluxFill
          : adapter.processFashnV16
      const { logCost } = await import('./cost-log.mjs')
      const result = await process({ supabase, pendingActionId, payload, logCost })
      const { postProcessImage } = await import('./cs/branding.mjs')
      const finishing = await postProcessImage(supabase, pendingActionId, result.storagePath)
      await callJobResult(pendingActionId, 'success', {
        storagePath: result.storagePath,
        allPaths: result.allPaths,
        provider: 'fal',
        falEngine: result.falEngine,
        falEndpointId: result.falEndpointId,
        requestId: result.requestId,
        seed: result.seed ?? undefined,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
        researchOnly: result.researchOnly ?? undefined,
        // CS7 — precision-edit lineage: mask + protected-pixel proof
        maskPath: result.maskPath ?? undefined,
        maskPreset: result.maskPreset ?? undefined,
        protectedDiff: result.protectedDiff ?? undefined,
        creativeStudio: true,
        studioMode: payload.studioMode,
        qc: result.qc ?? undefined,
        ...finishing,
      })
      console.log(`[worker] fal:${payload.falEngine} ${pendingActionId} — done → ${result.storagePath}`)
    } catch (err) {
      await callJobResult(pendingActionId, 'failed', undefined, err.message)
      console.error(`[worker] fal:${payload.falEngine} ${pendingActionId} — failed:`, err.message)
    }
    return
  }

  if (payload.provider === 'fashn') {
    try {
      const { isEngineKilled } = await import('./fal/client.mjs')
      if (await isEngineKilled(supabase, 'fashn')) {
        await callJobResult(pendingActionId, 'failed', undefined, 'FASHN ইঞ্জিনটি kill switch দিয়ে বন্ধ করা আছে — সেটিংস থেকে চালু করে আবার চালান।')
        return
      }
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
    // Attribute spend to the ACTUAL engine (2026-07-12: everything was logged as
    // 'gemini', so GPT/Seedream renders polluted the owner's Gemini spend report).
    const engine = modelName.startsWith('gpt-image') ? 'openai'
      : modelName.startsWith('seedream') ? 'fal'
      : 'gemini'
    const engineCostUsd = engine === 'openai'
      ? (quality === 'standard' ? 0.05 : 0.19)     // gpt-image-2 medium / high (approx list)
      : engine === 'fal'
        ? (quality === 'standard' ? 0.0675 : 0.135) // Seedream 5.0 Pro ≤1536px / 2K (fal list)
        : calcGeminiImageCostUsd(quality === 'standard' ? 'standard' : 'pro', resolvedImageSize)
    void logCost({
      provider: engine,
      kind: 'image',
      units: {
        quality,
        model: modelName,
        aspectRatio: resolvedAspectRatio,
        imageSize: resolvedImageSize,
        pendingActionId,
        qcAttempt,
      },
      costUsd: engineCostUsd,
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

// ── Phase 35: durable specialist fan-out consumer ────────────────────────────
// The runner (agent-graph-run.mjs) owns the durable contract: checkpoint after
// every brief, resume skips completed briefs, heartbeat, cancellation,
// deadline checkpoint. Each brief executes as ONE self-contained internal
// turn via the chat route (same mechanism as run-streamed-turn) — the worker
// stays modelless and the app keeps every guard.
const agentGraphWorker = new Worker('agent-graph-run', async (job) => {
  const { pendingActionId, payload } = job.data
  const { createAgentGraphRunner } = await import('./agent-graph-run.mjs')

  const readRow = async (cols) => {
    const { data } = await supabase
      .from('agent_pending_actions')
      .select(cols)
      .eq('id', pendingActionId)
      .maybeSingle()
    return data ?? null
  }
  const mergeResult = async (patch) => {
    const row = await readRow('result')
    const result = { ...(row?.result ?? {}), ...patch }
    await supabase.from('agent_pending_actions').update({ result }).eq('id', pendingActionId)
  }

  const runner = createAgentGraphRunner({
    runBrief: async (brief) => {
      const res = await fetch(`${getAppUrl()}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getInternalToken()}` },
        body: JSON.stringify({
          conversationId: payload?.conversationId ?? brief.conversationId ?? null,
          message:
            `[INTERNAL SPECIALIST BRIEF — role: ${brief.role}]\n` +
            `${brief.task}\n` +
            `শুধু তথ্যভিত্তিক ফলাফল দাও (findings/evidence/অনিশ্চয়তা/পরের ধাপের প্রস্তাব) — মালিককে সরাসরি সম্বোধন নয়।`,
          internalControl: true,
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      })
      if (!res.ok) return { success: false, summary: '', error: `chat_http_${res.status}` }
      const data = await res.json().catch(() => ({}))
      const summary = typeof data?.reply === 'string' ? data.reply : (data?.text ?? '')
      return { success: Boolean(summary), summary, error: summary ? undefined : 'empty_reply' }
    },
    saveProgress: async (progress) => mergeResult({ graphRunProgress: progress }),
    loadProgress: async () => {
      const row = await readRow('result')
      return row?.result?.graphRunProgress ?? null
    },
    heartbeat: async () => mergeResult({ graphRunHeartbeatAt: new Date().toISOString() }),
    isCancelled: async () => {
      const row = await readRow('status')
      return ['rejected', 'cancelled', 'expired'].includes(row?.status ?? '')
    },
  })

  const result = await runner(payload ?? {})
  if (result.status === 'done') {
    await callJobResult(pendingActionId, 'success', { findings: result.findings, resumedFrom: result.resumedFrom })
    console.log(`[agent-graph-run] ${pendingActionId} done: ${result.findings.length} findings (resumedFrom=${result.resumedFrom})`)
  } else if (result.status === 'cancelled') {
    await callJobResult(pendingActionId, 'failed', undefined, 'cancelled_by_owner')
    console.log(`[agent-graph-run] ${pendingActionId} cancelled by owner`)
  } else {
    // Deadline checkpoint: requeue the tail — the completed-set skip resumes.
    await agentGraphQueue.add('run', job.data, { jobId: `${pendingActionId}:r${Date.now()}` })
    console.log(`[agent-graph-run] ${pendingActionId} deadline checkpoint — ${result.remaining} briefs requeued`)
  }
}, { connection, concurrency: 1, lockDuration: 30 * 60 * 1000 })
agentGraphWorker.on('failed', (job, err) => {
  console.error(`[agent-graph-run] job ${job?.id} failed:`, err?.message)
})

const longTaskWorker = new Worker('long-agent-task', async (job) => {
  // Phase 54: durable task graph run — leased, checkpointed, crash-resumable.
  // BullMQ retries are SAFE here (unlike turns): every node checkpoints and
  // effect nodes are exactly-once, so a re-delivery resumes instead of
  // duplicating work.
  if (job.name === 'durable-task' && job.data?.workflowRunId) {
    const { runDurableTaskOnWorker } = await import('./agent-task-runner.mjs')
    const result = await runDurableTaskOnWorker({ sb: supabase, runId: job.data.workflowRunId })
    console.log(`[worker] durable-task ${job.data.workflowRunId} → ${result.status} (${result.completed.length} nodes)`)
    if (result.status === 'blocked' || result.status === 'lease_unavailable') {
      // Let BullMQ's backoff retry resume it later.
      throw new Error(`durable task ${result.status}: ${result.blocker ?? 'lease held elsewhere'}`)
    }
    return
  }

  // A2: owner web turn enqueued by /api/assistant/turn. Identified by turnId.
  // Runs the turn via the chat route in stream mode and republishes events to
  // Redis + the agent_turn_events log so the client can tail/replay it.
  if (job.data?.turnId) {
    // Double-run guard (owner bug 2026-07-12: finished research restarted from
    // scratch in the same thread). A stale/duplicate delivery of this job —
    // BullMQ stall re-queue, old backlog after a worker restart — must NEVER
    // re-run a turn that already reached a terminal status. The durable turn
    // row is the source of truth: only a still-'running' turn may execute.
    try {
      const { data: turnRow } = await supabase
        .from('agent_turns')
        .select('status')
        .eq('id', job.data.turnId)
        .maybeSingle()
      if (turnRow && turnRow.status !== 'running') {
        console.warn(`[worker] streamed-turn ${job.data.turnId} skipped — turn already '${turnRow.status}' (stale duplicate delivery)`)
        return
      }
    } catch (err) {
      console.warn(`[worker] streamed-turn ${job.data.turnId} status pre-check failed (continuing):`, err.message)
    }
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
}, {
  connection: longTaskConnection,
  concurrency: 1,
  // A streamed turn may legitimately run up to 25 min (run-streamed-turn's fetch
  // timeout). The old 6-min lock meant one missed renewal marked a healthy long
  // turn "stalled" → BullMQ re-queued it → the WHOLE research re-ran in the same
  // thread as soon as the first run finished (owner bug 2026-07-12). Lock now
  // covers the longest legitimate turn, and maxStalledCount: 0 fails a genuinely
  // stalled job instead of ever double-running it.
  lockDuration: 30 * 60 * 1000,
  maxStalledCount: 0,
})

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

// ── Long-task Redis circuit breaker (2026-07-14 incident) ────────────────────
// LONG_TASK_REDIS_URL is a metered CLOUD Redis (Upstash) — the ONLY queue not on
// the worker's local Redis, because Vercel and the VPS must share it for A2
// "finish my app/web task while I'm away". When its monthly request quota was
// exhausted, every BullMQ poll returned "max requests limit exceeded" and the
// poll loop retried with no backoff — ~10M errors, a 10GB log, and (worst) it
// STARVED this single-threaded process's event loop. The Telegram bot and the
// approve/reject callback handlers live in the SAME process, so a dependency the
// owner never touches from Telegram froze the buttons he DOES use (this is the
// answer to "Upstash has no link to Telegram, why did it break?"). On sustained
// Redis-unavailable errors we PAUSE the long-task worker (stops the poll storm,
// frees the loop) and retry after a cooldown; Telegram stays responsive, and the
// away-task feature self-heals when the quota resets / is upgraded.
let longTaskRedisErrs = 0
let longTaskBreakerOpen = false
const LONG_TASK_ERR_THRESHOLD = 20
const LONG_TASK_COOLDOWN_MS = 15 * 60 * 1000
function isRedisUnavailableErr(err) {
  const m = String(err?.message ?? err ?? '')
  return m.includes('max requests limit') ||
    m.includes('max daily request') ||
    m.includes('ECONNREFUSED') ||
    m.includes('ETIMEDOUT') ||
    m.includes('Connection is closed') ||
    m.includes('enableOfflineQueue')
}
async function tripLongTaskBreaker(reason) {
  if (longTaskBreakerOpen) return
  longTaskBreakerOpen = true
  console.error(`[long-task] Redis unhealthy (${reason}) — pausing worker ${LONG_TASK_COOLDOWN_MS / 60000}min to protect the shared event loop; Telegram stays live`)
  try { await longTaskWorker.pause(true) } catch { /* already paused/closing */ }
  setTimeout(async () => {
    longTaskRedisErrs = 0
    longTaskBreakerOpen = false
    try {
      await longTaskWorker.resume()
      console.log('[long-task] worker resumed after cooldown — probing Redis health')
    } catch (e) {
      console.warn('[long-task] resume failed:', e.message)
    }
  }, LONG_TASK_COOLDOWN_MS)
}
// The 'error' listener also prevents an unhandled worker error from bubbling to
// the process-level handler and re-spamming logs/Sentry.
function noteLongTaskRedisError(err, source) {
  longTaskRedisErrs++
  // Throttle: 1 line per 500 errors so a dead Redis can never fill the disk.
  if (longTaskRedisErrs % 500 === 1) {
    console.error(`[long-task] redis unavailable x${longTaskRedisErrs} (${source}): ${String(err?.message ?? err).slice(0, 100)}`)
  }
  if (longTaskRedisErrs >= LONG_TASK_ERR_THRESHOLD) tripLongTaskBreaker('redis quota/connection errors')
}
longTaskWorker.on('error', (err) => {
  if (isRedisUnavailableErr(err)) noteLongTaskRedisError(err, 'worker.error')
  else console.error('[long-task] worker error:', err?.message)
})
// The 2026-07-14 storm surfaced as unhandledRejection (BullMQ's poll-loop command
// rejections), NOT as worker 'error' — so trip the breaker from that source too.
// Pausing the worker halts the poll loop that emits these, ending the storm.
process.on('unhandledRejection', (reason) => {
  if (isRedisUnavailableErr(reason)) noteLongTaskRedisError(reason, 'unhandledRejection')
})

// Turn-consumer heartbeat (2026-07-13 incident: this consumer sat dead for 11 days
// while the HTTP poll loop looked healthy, so approval continuations silently hung).
// Written ONLY while the BullMQ consumer is actually running — the app's
// approval-continuation reads it and runs the turn inline when it goes stale.
setInterval(async () => {
  try {
    if (!longTaskWorker.isRunning()) return
    const now = new Date().toISOString()
    await supabase
      .from('agent_kv_settings')
      .upsert({ key: 'worker_heartbeat_at', value: now, updated_at: now }, { onConflict: 'key' })
  } catch (err) {
    console.warn('[worker] heartbeat write failed:', err.message)
  }
}, 60 * 1000)

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
    // CS11 — the owner sees a Bangla code, never raw provider/ffmpeg text
    const { sanitizeVideoError } = await import('./video-qc.mjs')
    await callJobResult(job.data.pendingActionId, 'failed', undefined, sanitizeVideoError(err, `video-gen ${job.id}`))
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
    const { sanitizeVideoError } = await import('./video-qc.mjs')
    await callJobResult(job.data.pendingActionId, 'failed', undefined, sanitizeVideoError(err, `video-edit ${job.id}`))
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
    const { sanitizeVideoError } = await import('./video-qc.mjs')
    await callJobResult(job.data.pendingActionId, 'failed', undefined, sanitizeVideoError(err, `video-finish ${job.id}`))
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

// Phase 53 — effect-outbox dispatcher (OFF by default; readiness gates flip it).
// Dispatch posts the run back to the app's assistant surface, where the guard +
// effect engine own execution; the worker only drives retries/dead-letter.
if (process.env.AGENT_EFFECT_ENGINE === 'true') {
  const { startEffectWorkerLoop } = await import('./effect-worker.mjs')
  startEffectWorkerLoop({
    sb: supabase,
    dispatch: async (run) => {
      try {
        const res = await fetch(`${getAppUrl()}/api/assistant/internal/health`, {
          method: 'GET',
          headers: { 'x-agent-internal-token': getInternalToken() },
        })
        // Phase 54 wires real dispatch (durable task graph); until then the
        // dispatcher only confirms app reachability and reports not-ok so rows
        // back off instead of silently draining.
        return res.ok
          ? { ok: false, error: `dispatch target for tool ${run.tool} not wired yet (Phase 54)` }
          : { ok: false, error: `app unreachable: ${res.status}` }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
  console.log('[worker] Phase 53 effect-outbox dispatcher started')

  // Phase 58 — continuous reconciler: stale executing → unknown, stuck
  // unknowns → owner alert, expired outbox leases → released.
  const { startAutonomyReconcilerLoop } = await import('./autonomy-reconciler.mjs')
  startAutonomyReconcilerLoop({
    sb: supabase,
    notify: async (message) => {
      try {
        await fetch(`${getAppUrl()}/api/assistant/internal/urgent-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getInternalToken()}` },
          body: JSON.stringify({ tier: 2, title: '⚠️ অনিশ্চিত effect', message, voice: false, category: 'effect_unknown' }),
        }).catch(() => {})
      } catch { /* alert best-effort */ }
    },
  })
  console.log('[worker] Phase 58 autonomy reconciler started')
}

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

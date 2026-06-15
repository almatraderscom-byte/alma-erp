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

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __workerDir = dirname(fileURLToPath(import.meta.url))
// PM2 may cache stale env vars — worker/.env must always win (e.g. rotated FB tokens).
dotenv.config({ path: join(__workerDir, '../.env'), override: true })
import { initWorkerSentry, captureWorkerError } from './sentry.mjs'
import { startHeartbeatLoop } from './heartbeat.mjs'
import { startHealthPingLoop } from './health-ping.mjs'
import { Queue, Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { launchTelegramBot, stopTelegramBot } from './telegram/launcher.mjs'
import { setupSchedulers } from './schedulers/index.mjs'
import { dispatchTasksToStaff } from './staff/dispatch.mjs'
import { sendStaffAnnouncement } from './staff/announcement.mjs'
import { initializeDailySalahRecords } from './salah/scheduler.mjs'
import { startTwilioHttpServer } from './twilio-http.mjs'
import { deliverAgentTurn } from './telegram/agent-turn.mjs'
import { startDiagnosticHttpServer } from './diagnostic-http.mjs'

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
const APP_URL        = process.env.APP_URL.replace(/\/$/, '')
const INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN
const GEMINI_KEY     = process.env.GEMINI_API_KEY
const SUPABASE_URL   = process.env.SUPABASE_URL
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Clients ────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const genai    = new GoogleGenAI({ apiKey: GEMINI_KEY })

const connection = { url: REDIS_URL }

// ── Queues ─────────────────────────────────────────────────────────────────

const imageGenQueue = new Queue('image-gen', {
  connection,
  defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
})

const longTaskQueue = new Queue('long-agent-task', {
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
  let query = supabase
    .from('staff_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('proposed_for', date)
    .in('status', ['sent', 'done'])
  if (Array.isArray(taskIds) && taskIds.length) {
    query = query.in('id', taskIds)
  }
  const { count } = await query
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

// ── Polling for new approved jobs ──────────────────────────────────────────

async function pollPendingJobs() {
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/pending-jobs`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
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
      enqueuedIds.add(job.id)
      if (job.type === 'image_gen') {
        await imageGenQueue.add('generate', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued image-gen job for action ${job.id}`)
      } else if (job.type === 'long_agent_task') {
        await longTaskQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
      } else if (job.type === 'dispatch_staff_tasks' || job.type === 'add_staff_task_now' || job.type === 'staff_announcement') {
        await staffDispatchQueue.add('dispatch', { pendingActionId: job.id, payload: job.payload, type: job.type }, { jobId: job.id })
        console.log(`[worker] enqueued staff dispatch for action ${job.id}`)
      } else if (job.type === 'urgent_notify') {
        const { processUrgentNotify } = await import('./reminders/ticker.mjs')
        await processUrgentNotify(job.payload)
        await callJobResult(job.id, 'success', { ok: true })
        console.log(`[worker] urgent_notify dispatched for action ${job.id}`)
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
      }
    }
  } catch (err) {
    console.error('[worker] poll error:', err.message)
    captureWorkerError(err, 'worker.poll_pending_jobs')
  }
}

// ── Image generation handler ───────────────────────────────────────────────

async function processImageGen(job) {
  const { pendingActionId, payload } = job.data
  console.log(`[worker] image-gen ${pendingActionId} — starting`)

  if (!payload) {
    await callJobResult(pendingActionId, 'failed', undefined, 'No payload in job data')
    return
  }

  const { prompt, quality, referenceImageId, secondReferenceImageId, conversationId } = payload

  const modelName = quality === 'standard'
    ? 'gemini-3.1-flash-image-preview'
    : 'gemini-3-pro-image-preview'

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
    config: { responseModalities: ['IMAGE', 'TEXT'] },
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
  const storagePath = `generated/${pendingActionId}.${ext}`
  const imageBuffer = Buffer.from(imageBase64, 'base64')

  const { error: uploadErr } = await supabase
    .storage
    .from('agent-files')
    .upload(storagePath, imageBuffer, { contentType: imageMimeType, upsert: true })

  if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`)

  // Private bucket — job-result route signs storagePath for the chat message.
  await callJobResult(pendingActionId, 'success', {
    storagePath,
    conversationId,
  })

  const { logCost, calcGeminiImageCostUsd } = await import('./cost-log.mjs')
  void logCost({
    provider: 'gemini',
    kind: 'image',
    units: { quality, model: modelName, pendingActionId },
    costUsd: calcGeminiImageCostUsd(quality === 'standard' ? 'standard' : 'pro'),
    conversationId: conversationId ?? undefined,
    jobId: pendingActionId,
    dedupKey: `image:${pendingActionId}`,
  })

  console.log(`[worker] image-gen ${pendingActionId} — done → ${storagePath}`)
}

// ── Callback ───────────────────────────────────────────────────────────────

async function callJobResult(pendingActionId, status, data, error) {
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/job-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      body: JSON.stringify({ pendingActionId, status, data, error }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[worker] job-result callback HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (err) {
    console.error('[worker] job-result callback error:', err.message)
  }
}

// ── Workers ────────────────────────────────────────────────────────────────

const imageGenWorker = new Worker('image-gen', processImageGen, {
  connection,
  concurrency: 2,
})

const longTaskWorker = new Worker('long-agent-task', async (job) => {
  console.log(`[worker] long-agent-task ${job.id} — not yet implemented`)
}, { connection, concurrency: 1 })

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
        ).catch(() => {})
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

staffDispatchWorker.on('failed', async (job, err) => {
  console.error(`[worker] staff-dispatch ${job?.id} failed:`, err.message)
  if (job?.data?.pendingActionId) {
    enqueuedIds.delete(job.data.pendingActionId)
    await callJobResult(job.data.pendingActionId, 'failed', undefined, err.message).catch(() => {})
    const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
    if (ownerChatId && telegramBot) {
      await telegramBot.telegram.sendMessage(
        ownerChatId,
        `❌ Task dispatch ব্যর্থ: ${err.message?.slice(0, 150)}। আবার চেষ্টা করুন।`,
      ).catch(() => {})
    }
  }
})

imageGenWorker.on('completed', (job) => console.log(`[worker] image-gen ${job.id} completed`))
imageGenWorker.on('failed', (job, err) => {
  console.error(`[worker] image-gen ${job?.id} failed:`, err.message)
  captureWorkerError(err, 'worker.image_gen.failed', { jobId: job?.id })
  if (job?.data?.pendingActionId) {
    callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

// ── Telegram bot (singleton — one getUpdates poller per process) ───────────

let telegramBot = null

if (process.env.ASSISTANT_BOT_TOKEN) {
  try {
    telegramBot = await launchTelegramBot()
  } catch (err) {
    console.error('[telegram] Failed to start bot:', err.message)
  }
} else {
  console.warn('[worker] ASSISTANT_BOT_TOKEN not set — Telegram bot disabled')
}

// ── Phase 6: Schedulers ────────────────────────────────────────────────────

let schedulerQueue = null
let runSchedulerJobFn = null
try {
  const schedulerSetup = await setupSchedulers({
    connection,
    supabase,
    bot: telegramBot,
  })
  schedulerQueue = schedulerSetup?.schedulerQueue ?? null
  runSchedulerJobFn = schedulerSetup?.runSchedulerJob ?? null
  if (schedulerQueue) {
    // Initialize today's salah records on startup (idempotent)
    await initializeDailySalahRecords(supabase).catch(err =>
      console.error('[salah] init failed:', err.message)
    )
    // Catch-up missed critical duties after worker was down
    if (runSchedulerJobFn) {
      setTimeout(() => {
        import('./schedulers/catchup.mjs')
          .then(({ runCatchup }) =>
            runCatchup({
              supabase,
              bot: telegramBot,
              runJob: (name, opts) => runSchedulerJobFn(name, opts),
            }),
          )
          .catch((e) => console.error('[catchup] startup:', e.message))
      }, 15_000)
    }
  }
} catch (err) {
  console.error('[schedulers] setup error:', err.message)
}

// ── Start polling ──────────────────────────────────────────────────────────

await pollPendingJobs()
const pollInterval = setInterval(pollPendingJobs, 30_000)

const { pollCsPendingReplies } = await import('./cs/reply.mjs')
const csEnqueued = new Set()

async function pollAndEnqueueCsReplies() {
  try {
    const res = await fetch(`${APP_URL}/api/assistant/internal/cs-pending-replies`, {
      headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
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

csReplyWorker.on('failed', (job, err) => {
  console.error(`[cs-reply] ${job?.id} failed:`, err.message)
  if (job?.id) csEnqueued.delete(job.id)
})

await pollAndEnqueueCsReplies()
const csPollInterval = setInterval(pollAndEnqueueCsReplies, 10_000)

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
startDiagnosticHttpServer()

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
  await stopTelegramBot(signal)
  await Promise.all([
    imageGenWorker.close(),
    longTaskWorker.close(),
    staffDispatchWorker.close(),
    csReplyWorker.close(),
  ])
  process.exit(0)
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))

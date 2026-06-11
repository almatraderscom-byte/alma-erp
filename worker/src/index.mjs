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

import 'dotenv/config'
import { Queue, Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenAI } from '@google/genai'
import { createTelegramBot } from './telegram/index.mjs'

// ── Env checks ─────────────────────────────────────────────────────────────

const required = [
  'REDIS_URL',
  'APP_URL',
  'AGENT_INTERNAL_TOKEN',
  'GEMINI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]
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
      if (enqueuedIds.has(job.id)) continue
      enqueuedIds.add(job.id)
      if (job.type === 'image_gen') {
        await imageGenQueue.add('generate', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
        console.log(`[worker] enqueued image-gen job for action ${job.id}`)
      } else if (job.type === 'long_agent_task') {
        await longTaskQueue.add('run', { pendingActionId: job.id, payload: job.payload }, { jobId: job.id })
      }
    }
  } catch (err) {
    console.error('[worker] poll error:', err.message)
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

  const { prompt, quality, referenceImageId, conversationId } = payload

  const modelName = quality === 'standard'
    ? 'gemini-3.1-flash-image-preview'
    : 'gemini-3-pro-image-preview'

  let contents = [{ text: prompt }]

  if (referenceImageId) {
    const { data: fileData, error: dlErr } = await supabase
      .storage
      .from('agent-files')
      .download(referenceImageId)

    if (!dlErr && fileData) {
      const arrayBuffer = await fileData.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')
      contents = [
        { inlineData: { mimeType: fileData.type || 'image/jpeg', data: base64 } },
        { text: prompt },
      ]
    }
  }

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
    if (!res.ok) console.error(`[worker] job-result callback HTTP ${res.status}`)
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

imageGenWorker.on('completed', (job) => console.log(`[worker] image-gen ${job.id} completed`))
imageGenWorker.on('failed', (job, err) => {
  console.error(`[worker] image-gen ${job?.id} failed:`, err.message)
  if (job?.data?.pendingActionId) {
    callJobResult(job.data.pendingActionId, 'failed', undefined, err.message)
  }
})

// ── Telegram bot ───────────────────────────────────────────────────────────

let telegramBot = null

if (process.env.ASSISTANT_BOT_TOKEN) {
  try {
    telegramBot = createTelegramBot()
    telegramBot.launch({ dropPendingUpdates: true })
      .then(() => console.log('[telegram] Bot started (long-polling)'))
      .catch((err) => console.error('[telegram] Bot launch failed:', err.message))
    console.log('[telegram] Bot initializing...')
  } catch (err) {
    console.error('[telegram] Failed to create bot:', err.message)
  }
} else {
  console.warn('[worker] ASSISTANT_BOT_TOKEN not set — Telegram bot disabled')
}

// ── Start polling ──────────────────────────────────────────────────────────

await pollPendingJobs()
const pollInterval = setInterval(pollPendingJobs, 30_000)

console.log('[worker] ALMA Agent Worker started — polling every 30s for approved jobs')

process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM — draining...')
  clearInterval(pollInterval)
  if (telegramBot) telegramBot.stop('SIGTERM')
  await Promise.all([imageGenWorker.close(), longTaskWorker.close()])
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[worker] SIGINT — shutting down...')
  clearInterval(pollInterval)
  if (telegramBot) telegramBot.stop('SIGINT')
  await Promise.all([imageGenWorker.close(), longTaskWorker.close()])
  process.exit(0)
})

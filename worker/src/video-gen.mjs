/**
 * Veo 3.1 image-to-video — mirrors processImageGen pattern.
 * Long-running: submit → poll operation → download → QC → upload.
 *
 * CS11 hardening:
 *  - the Veo OPERATION NAME is persisted to agent_kv_settings (`veo_op:<id>`)
 *    the moment it exists — a worker restart (or Redis loss) resumes the SAME
 *    paid generation instead of paying again;
 *  - deterministic video QC (black/frozen/duration) gates the artifact, with
 *    ONE bounded regeneration on critical failure — never an endless loop;
 *  - sampled frames are compared to the approved reference still (narrow
 *    mechanical check) and the verdict ships in the result metadata;
 *  - owner-facing errors are sanitized Bangla codes (raw → worker log);
 *  - actual API cost rides the result (ffmpeg-only edits stay $0).
 */
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  assertStudioRunPaidAttempt,
  authorizeStudioRunExecution,
} from './studio-run-authorize.mjs'

export const VEO_MODEL = 'veo-3.1-generate-preview'

const POLL_MS = 10_000
const MAX_POLL_MS = 12 * 60 * 1000 // 12 min hard cap per job attempt
const MAX_GEN_ATTEMPTS = 2 // 1 normal + 1 QC-forced regeneration

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const opKey = (id) => `veo_op:${id}`

async function loadPersistedOp(supabase, pendingActionId) {
  try {
    const { data } = await supabase
      .from('agent_kv_settings')
      .select('value')
      .eq('key', opKey(pendingActionId))
      .maybeSingle()
    return data?.value ? JSON.parse(data.value) : null
  } catch {
    return null
  }
}

async function persistOp(supabase, pendingActionId, record) {
  try {
    await supabase
      .from('agent_kv_settings')
      .upsert({ key: opKey(pendingActionId), value: JSON.stringify(record) }, { onConflict: 'key' })
  } catch (err) {
    console.warn(`[worker] video-gen ${pendingActionId} — op persist failed: ${err.message}`)
  }
}

async function clearPersistedOp(supabase, pendingActionId) {
  try {
    await supabase.from('agent_kv_settings').delete().eq('key', opKey(pendingActionId))
  } catch { /* best-effort */ }
}

/** Seedance pricing mirror (see src/agent/lib/pricing.ts — keep in sync). */
const SEEDANCE_PER_SECOND = {
  'bytedance/seedance-2.5/image-to-video:720p': 0.473,
  'bytedance/seedance-2.5/image-to-video:480p': 0.2205,
  'fal-ai/bytedance/seedance/v1/pro/image-to-video:1080p': 0.125,
  'fal-ai/bytedance/seedance/v1/lite/image-to-video:720p': 0.037,
}

const SEEDANCE_ALLOWED_ENDPOINTS = new Set([
  'bytedance/seedance-2.5/image-to-video',
  'fal-ai/bytedance/seedance/v1/pro/image-to-video',
  'fal-ai/bytedance/seedance/v1/lite/image-to-video',
])

/**
 * Seedance image-to-video via the fal queue API: submit → poll → download →
 * upload to agent-files. Resumable like the Veo path — the fal request id is
 * persisted to kv so a worker restart polls the SAME paid request.
 */
async function processSeedanceVideo(job, { supabase, callJobResult }) {
  const { pendingActionId, payload } = job.data
  const {
    prompt,
    referenceImageId,
    durationSec = 6,
    aspect = '9:16',
    conversationId,
    falEndpoint,
    falResolution = '720p',
  } = payload

  const falKey = process.env.FAL_KEY ?? ''
  if (!falKey) {
    await callJobResult(pendingActionId, 'failed', undefined, 'FAL_KEY missing on worker — Seedance unavailable')
    return
  }
  const endpoint = SEEDANCE_ALLOWED_ENDPOINTS.has(String(falEndpoint)) ? String(falEndpoint) : null
  if (!endpoint) {
    await callJobResult(pendingActionId, 'failed', undefined, `seedance endpoint not allowed: ${falEndpoint}`)
    return
  }

  // fal needs a fetchable image URL — short-lived signed URL from storage.
  const { data: signed, error: signErr } = await supabase.storage
    .from('agent-files')
    .createSignedUrl(String(referenceImageId ?? ''), 3600)
  if (signErr || !signed?.signedUrl) {
    await callJobResult(pendingActionId, 'failed', undefined, `reference image sign failed: ${signErr?.message}`)
    return
  }

  const falHeaders = { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' }
  // Resume: kv-persisted fal request (with its queue URLs) survives worker
  // restarts — the SAME paid request is polled, never re-submitted.
  let statusUrl = null
  let responseUrl = null
  const persisted = await loadPersistedOp(supabase, pendingActionId)
  if (persisted?.provider === 'seedance' && persisted.statusUrl && persisted.responseUrl) {
    statusUrl = persisted.statusUrl
    responseUrl = persisted.responseUrl
    console.log(`[worker] video-gen ${pendingActionId} — resuming persisted fal request (no new paid gen)`)
  }
  if (!statusUrl) {
    const submitRes = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: 'POST',
      headers: falHeaders,
      body: JSON.stringify({
        prompt: String(prompt ?? ''),
        image_url: signed.signedUrl,
        duration: Math.min(15, Math.max(3, Math.round(Number(durationSec) || 6))),
        resolution: falResolution,
        aspect_ratio: aspect === '16:9' ? '16:9' : '9:16',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => '')
      await callJobResult(pendingActionId, 'failed', undefined, `seedance submit ${submitRes.status}: ${body.slice(0, 200)}`)
      return
    }
    const submitted = await submitRes.json()
    // The queue API returns canonical URLs — use them, never hand-construct.
    statusUrl = submitted.status_url
    responseUrl = submitted.response_url
    if (!submitted.request_id || !statusUrl || !responseUrl) {
      await callJobResult(pendingActionId, 'failed', undefined, 'seedance submit returned no request/status url')
      return
    }
    await persistOp(supabase, pendingActionId, {
      name: submitted.request_id,
      provider: 'seedance',
      statusUrl,
      responseUrl,
      pollStartedAt: Date.now(),
      attempt: 1,
    })
  }

  const startedAt = Date.now()
  let videoUrl = null
  while (true) {
    if (Date.now() - startedAt > MAX_POLL_MS) {
      await callJobResult(pendingActionId, 'failed', undefined, 'seedance generation timed out')
      return
    }
    await sleep(POLL_MS)
    const stRes = await fetch(statusUrl, { headers: falHeaders, signal: AbortSignal.timeout(20_000) }).catch(() => null)
    if (!stRes?.ok) continue
    const st = await stRes.json().catch(() => ({}))
    if (st.status === 'COMPLETED') {
      const resultRes = await fetch(responseUrl, { headers: falHeaders, signal: AbortSignal.timeout(30_000) })
      const result = await resultRes.json().catch(() => ({}))
      videoUrl = result?.video?.url ?? result?.video_url ?? null
      break
    }
    if (st.status === 'FAILED' || st.status === 'ERROR') {
      await callJobResult(pendingActionId, 'failed', undefined, `seedance request failed: ${JSON.stringify(st).slice(0, 200)}`)
      return
    }
  }
  if (!videoUrl) {
    await callJobResult(pendingActionId, 'failed', undefined, 'seedance completed without a video url')
    return
  }

  const dlRes = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) })
  if (!dlRes.ok) {
    await callJobResult(pendingActionId, 'failed', undefined, `seedance video download ${dlRes.status}`)
    return
  }
  const videoBuffer = Buffer.from(await dlRes.arrayBuffer())
  const storagePath = `generated/${pendingActionId}.mp4`
  const { error: uploadErr } = await supabase.storage
    .from('agent-files')
    .upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true })
  if (uploadErr) {
    await callJobResult(pendingActionId, 'failed', undefined, `Supabase upload failed: ${uploadErr.message}`)
    return
  }
  await clearPersistedOp(supabase, pendingActionId)

  const rate = SEEDANCE_PER_SECOND[`${endpoint}:${falResolution}`] ?? SEEDANCE_PER_SECOND['bytedance/seedance-2.5/image-to-video:720p']
  const costUsd = Math.round(rate * Math.max(1, Math.round(Number(durationSec) || 6)) * 1e6) / 1e6

  await callJobResult(pendingActionId, 'success', {
    storagePath,
    conversationId,
    aspect,
    durationSec,
    mediaType: 'video',
    provider: 'seedance',
    costUsd,
  })

  const { logCost } = await import('./cost-log.mjs')
  void logCost({
    provider: 'fal',
    kind: 'video',
    units: { model: endpoint, resolution: falResolution, durationSec, pendingActionId },
    costUsd,
    conversationId: conversationId ?? undefined,
    jobId: pendingActionId,
    dedupKey: `video:${pendingActionId}`,
  })
  console.log(`[worker] video-gen ${pendingActionId} — seedance done → ${storagePath}`)
}

/**
 * @param {import('bullmq').Job} job
 * @param {object} deps
 * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabase
 * @param {import('@google/genai').GoogleGenAI} deps.genai
 * @param {(id: string, status: string, data?: object, error?: string) => Promise<void>} deps.callJobResult
 */
export async function processVideoGen(job, { supabase, genai, callJobResult }) {
  const { pendingActionId, payload } = job.data

  if (!payload) {
    await callJobResult(pendingActionId, 'failed', undefined, 'No payload in job data')
    return
  }

  const authorization = await authorizeStudioRunExecution(pendingActionId, payload)
  if (!authorization.authorized) {
    await callJobResult(
      pendingActionId,
      'failed',
      undefined,
      `studio_run_revalidation_failed:${authorization.error}`,
    )
    return
  }

  const {
    prompt,
    referenceImageId,
    durationSec = 6,
    aspect = '9:16',
    conversationId,
    productCode,
  } = payload

  // Media mode: Seedance (fal) image-to-video rides its own path — queue-based
  // fal API, no Veo operation machinery. Veo jobs are untouched below.
  if (payload.provider === 'seedance') {
    await processSeedanceVideo(job, { supabase, callJobResult })
    return
  }

  console.log(`[worker] video-gen ${pendingActionId} — starting`)

  async function downloadRef(path) {
    if (!path) return null
    const { data: fileData, error: dlErr } = await supabase.storage.from('agent-files').download(path)
    if (dlErr || !fileData) return null
    return Buffer.from(await fileData.arrayBuffer())
  }

  // CS11 — generated reels start ONLY from an existing approved still.
  const refBuffer = await downloadRef(referenceImageId)
  if (!referenceImageId || !refBuffer) {
    await callJobResult(pendingActionId, 'failed', undefined, 'referenceImageId missing or download failed')
    return
  }
  const image = {
    imageBytes: refBuffer.toString('base64'),
    mimeType: 'image/jpeg',
  }
  const resolvedAspect = aspect === '16:9' ? '16:9' : '9:16'

  const { runVideoQc, sanitizeVideoError } = await import('./video-qc.mjs')

  /** One full generate→poll→download cycle. Returns the local file path. */
  async function generateOnce(attempt) {
    // Resume order: BullMQ job.data (same process retry) → kv (worker restart).
    let operation = attempt === 1 ? (payload._veoOperation ?? null) : null
    let pollStartedAt = payload._veoPollStartedAt ?? Date.now()
    if (!operation && attempt === 1) {
      const persisted = await loadPersistedOp(supabase, pendingActionId)
      if (persisted?.name && persisted.attempt === attempt) {
        operation = { name: persisted.name }
        pollStartedAt = persisted.pollStartedAt ?? Date.now()
        console.log(`[worker] video-gen ${pendingActionId} — resuming persisted Veo op (no new paid gen)`)
      }
    }

    if (!operation) {
      await assertStudioRunPaidAttempt(pendingActionId, payload, attempt)
      operation = await genai.models.generateVideos({
        model: VEO_MODEL,
        prompt,
        image,
        config: {
          aspectRatio: resolvedAspect,
          durationSeconds: durationSec,
          numberOfVideos: 1,
        },
      })
      pollStartedAt = Date.now()
      // Persist the operation NAME immediately — restart must not re-pay.
      await persistOp(supabase, pendingActionId, { name: operation.name, pollStartedAt, attempt })
      await job.updateData({
        ...job.data,
        payload: { ...payload, _veoOperation: operation, _veoPollStartedAt: pollStartedAt },
      })
      console.log(`[worker] video-gen ${pendingActionId} — Veo operation started (attempt ${attempt})`)
    }

    while (!operation.done) {
      if (Date.now() - pollStartedAt > MAX_POLL_MS) {
        throw new Error('Veo video generation timed out after 12 minutes')
      }
      await sleep(POLL_MS)
      operation = await genai.operations.getVideosOperation({ operation })
      await job.updateData({
        ...job.data,
        payload: { ...payload, _veoOperation: operation, _veoPollStartedAt: pollStartedAt },
      })
    }

    if (operation.error) {
      const errMsg = operation.error?.message ?? JSON.stringify(operation.error)
      throw new Error(`Veo operation failed: ${errMsg}`)
    }

    const generated = operation.response?.generatedVideos?.[0]?.video
    if (!generated) throw new Error('No video in Veo response')

    const tmpPath = join(tmpdir(), `veo-${pendingActionId}-${randomUUID().slice(0, 8)}.mp4`)
    try {
      await genai.files.download({ file: generated, downloadPath: tmpPath })
    } catch (dlErr) {
      // Operation stays persisted — a retry resumes retrieval, never re-pays.
      throw new Error(`Veo download failed: ${dlErr.message}`)
    }
    return tmpPath
  }

  let tmpPath = null
  let qc = null
  let attemptsUsed = 0
  try {
    const authorizedAttempts = Math.min(
      MAX_GEN_ATTEMPTS,
      Math.max(1, Number(payload.studioPaidAttemptLimit) || MAX_GEN_ATTEMPTS),
    )
    for (let attempt = 1; attempt <= authorizedAttempts; attempt++) {
      attemptsUsed = attempt
      tmpPath = await generateOnce(attempt)

      // CS11 — deterministic gate + reference consistency on the raw output.
      qc = await runVideoQc({ file: tmpPath, expectedDurationSec: durationSec, referenceBuf: refBuffer })
      if (qc.pass) break

      console.warn(`[worker] video-gen ${pendingActionId} — QC critical (attempt ${attempt}): ${qc.critical.join(' | ')}`)
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      tmpPath = null
      if (attempt < authorizedAttempts) {
        // fresh paid attempt is DELIBERATE: clear the persisted op first
        await clearPersistedOp(supabase, pendingActionId)
        payload._veoOperation = null
      } else {
        throw new Error(qc.critical[0] ?? 'QC_DURATION: video failed quality gate')
      }
    }
  } catch (err) {
    await callJobResult(pendingActionId, 'failed', undefined, sanitizeVideoError(err, `video-gen ${pendingActionId}`))
    return
  }

  const videoBuffer = readFileSync(tmpPath)
  try { unlinkSync(tmpPath) } catch { /* ignore */ }

  const storagePath = `generated/${pendingActionId}.mp4`
  const { error: uploadErr } = await supabase.storage
    .from('agent-files')
    .upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true })

  if (uploadErr) {
    await callJobResult(pendingActionId, 'failed', undefined, sanitizeVideoError(new Error(`Supabase upload failed: ${uploadErr.message}`), `video-gen ${pendingActionId}`))
    return
  }
  await clearPersistedOp(supabase, pendingActionId)

  const { logCost, calcVeoCostUsd } = await import('./cost-log.mjs')
  const costUsd = calcVeoCostUsd(durationSec) * attemptsUsed

  await callJobResult(pendingActionId, 'success', {
    storagePath,
    conversationId,
    productCode,
    aspect,
    durationSec,
    mediaType: 'video',
    // CS11 — truthful lineage + QC metadata
    approvedStillPath: referenceImageId,
    videoQc: {
      pass: qc?.pass ?? true,
      warnings: qc?.warnings ?? [],
      metrics: qc?.metrics ?? null,
      referenceCheck: qc?.referenceCheck ?? null,
      attempts: attemptsUsed,
    },
    costUsd,
  })

  void logCost({
    provider: 'veo',
    kind: 'video',
    units: {
      model: VEO_MODEL,
      durationSec,
      aspect,
      productCode: productCode ?? '',
      pendingActionId,
      attempts: attemptsUsed,
    },
    costUsd,
    conversationId: conversationId ?? undefined,
    jobId: pendingActionId,
    dedupKey: `video:${pendingActionId}`,
  })

  console.log(`[worker] video-gen ${pendingActionId} — done → ${storagePath} (QC ${qc?.pass ? 'pass' : 'flagged'}, ${attemptsUsed} attempt)`)
}

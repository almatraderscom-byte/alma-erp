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

  const {
    prompt,
    referenceImageId,
    durationSec = 6,
    aspect = '9:16',
    conversationId,
    productCode,
  } = payload

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
    for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
      attemptsUsed = attempt
      tmpPath = await generateOnce(attempt)

      // CS11 — deterministic gate + reference consistency on the raw output.
      qc = await runVideoQc({ file: tmpPath, expectedDurationSec: durationSec, referenceBuf: refBuffer })
      if (qc.pass) break

      console.warn(`[worker] video-gen ${pendingActionId} — QC critical (attempt ${attempt}): ${qc.critical.join(' | ')}`)
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      tmpPath = null
      if (attempt < MAX_GEN_ATTEMPTS) {
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

/**
 * Veo 3.1 image-to-video — mirrors processImageGen pattern.
 * Long-running: submit → poll operation (persisted in job.data) → download → upload.
 */
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export const VEO_MODEL = 'veo-3.1-generate-preview'

const POLL_MS = 10_000
const MAX_POLL_MS = 12 * 60 * 1000 // 12 min hard cap per job attempt

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
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

  async function toImageInput(path) {
    if (!path) return undefined
    const { data: fileData, error: dlErr } = await supabase.storage.from('agent-files').download(path)
    if (dlErr || !fileData) return undefined
    const arrayBuffer = await fileData.arrayBuffer()
    return {
      imageBytes: Buffer.from(arrayBuffer).toString('base64'),
      mimeType: fileData.type || 'image/jpeg',
    }
  }

  let operation = payload._veoOperation ?? null
  const pollStartedAt = payload._veoPollStartedAt ?? Date.now()

  if (!operation) {
    const image = await toImageInput(referenceImageId)
    if (!referenceImageId || !image) {
      await callJobResult(pendingActionId, 'failed', undefined, 'referenceImageId missing or download failed')
      return
    }

    const resolvedAspect = aspect === '16:9' ? '16:9' : '9:16'

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

    await job.updateData({
      ...job.data,
      payload: {
        ...payload,
        _veoOperation: operation,
        _veoPollStartedAt: pollStartedAt,
      },
    })
    console.log(`[worker] video-gen ${pendingActionId} — Veo operation started`)
  } else {
    console.log(`[worker] video-gen ${pendingActionId} — resuming poll`)
  }

  while (!operation.done) {
    if (Date.now() - pollStartedAt > MAX_POLL_MS) {
      throw new Error('Veo video generation timed out after 12 minutes')
    }
    await sleep(POLL_MS)
    operation = await genai.operations.getVideosOperation({ operation })
    await job.updateData({
      ...job.data,
      payload: {
        ...payload,
        _veoOperation: operation,
        _veoPollStartedAt: pollStartedAt,
      },
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
    await genai.files.download({
      file: generated,
      downloadPath: tmpPath,
    })
  } catch (dlErr) {
    throw new Error(`Veo download failed: ${dlErr.message}`)
  }

  const videoBuffer = readFileSync(tmpPath)
  try { unlinkSync(tmpPath) } catch { /* ignore */ }

  const storagePath = `generated/${pendingActionId}.mp4`
  const { error: uploadErr } = await supabase.storage
    .from('agent-files')
    .upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true })

  if (uploadErr) throw new Error(`Supabase upload failed: ${uploadErr.message}`)

  await callJobResult(pendingActionId, 'success', {
    storagePath,
    conversationId,
    productCode,
    aspect,
    durationSec,
    mediaType: 'video',
  })

  const { logCost, calcVeoCostUsd } = await import('./cost-log.mjs')
  void logCost({
    provider: 'veo',
    kind: 'video',
    units: {
      model: VEO_MODEL,
      durationSec,
      aspect,
      productCode: productCode ?? '',
      pendingActionId,
    },
    costUsd: calcVeoCostUsd(durationSec),
    conversationId: conversationId ?? undefined,
    jobId: pendingActionId,
    dedupKey: `video:${pendingActionId}`,
  })

  console.log(`[worker] video-gen ${pendingActionId} — done → ${storagePath}`)
}

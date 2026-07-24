/**
 * CS14 — Model Avatar build.
 *
 * 1) SHEET (free, deterministic): every angle photo normalized to a fixed
 *    portrait cell and tiled into ONE identity-sheet image (max 10 cells,
 *    3 per row). One image carrying every angle — this is how multi-angle
 *    identity fits inside xAI's 3-reference cap.
 * 2) CANONICAL (optional, paid ~$0.07): Grok edit over the sheet producing a
 *    clean neutral studio front portrait — the best single person reference
 *    for FASHN/Fal (which take exactly one model photo) and for xAI.
 *
 * Results land in agent-files `model-avatars/` and the kv row
 * `model_avatar:<modelId>` is updated (builtAt clears `building`).
 */
import { storagePathToBuffer } from '../fal/client.mjs'

const CELL_W = 512
const CELL_H = 640
const COLS = 3

export async function buildAvatarSheet({ supabase, modelId, imagePaths }) {
  const sharp = (await import('sharp')).default
  const paths = imagePaths.slice(0, 10)
  if (paths.length === 0) throw new Error('avatar: no images')

  const cells = []
  for (const p of paths) {
    const raw = await storagePathToBuffer(supabase, p)
    cells.push(
      await sharp(raw)
        .rotate()
        .resize(CELL_W, CELL_H, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 90 })
        .toBuffer(),
    )
  }
  const rows = Math.ceil(cells.length / COLS)
  const colsUsed = Math.min(COLS, cells.length)
  const sheet = await sharp({
    create: {
      width: colsUsed * CELL_W,
      height: rows * CELL_H,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(cells.map((buf, i) => ({
      input: buf,
      left: (i % COLS) * CELL_W,
      top: Math.floor(i / COLS) * CELL_H,
    })))
    .jpeg({ quality: 90 })
    .toBuffer()

  const sheetPath = `model-avatars/${modelId}-sheet.jpg`
  const { error } = await supabase.storage.from('agent-files').upload(sheetPath, sheet, {
    contentType: 'image/jpeg',
    upsert: true,
  })
  if (error) throw new Error(`avatar sheet upload failed: ${error.message}`)
  return sheetPath
}

const CANONICAL_PROMPT =
  'The reference image is an identity sheet showing THE SAME person photographed from multiple angles. ' +
  'Create ONE photorealistic studio portrait of this exact person: front-facing, chest-up, standing straight, ' +
  'natural relaxed expression, soft even studio lighting, plain light grey seamless background, no text, no collage. ' +
  "Preserve the person's exact face, age, skin tone, hair and identity — no beautification, no face changes."

export async function processAvatarBuild({ supabase, pendingActionId, payload, logCost }) {
  const modelId = String(payload.modelId ?? '').trim()
  const imagePaths = Array.isArray(payload.imagePaths) ? payload.imagePaths : []
  if (!modelId || imagePaths.length === 0) throw new Error('avatar_build needs modelId + imagePaths')

  const sheetPath = await buildAvatarSheet({ supabase, modelId, imagePaths })

  let canonicalPath = null
  if (payload.canonical) {
    const { processXaiImagine } = await import('../xai/adapter.mjs')
    const result = await processXaiImagine({
      supabase,
      pendingActionId,
      payload: {
        xaiModel: 'grok-imagine-image-quality',
        xaiOp: 'edit',
        referenceImagePaths: [sheetPath],
        referenceRoles: ['source'],
        prompt: CANONICAL_PROMPT,
        aspectRatio: '3:4',
        resolution: '2k',
        studioMode: 'avatar_canonical',
      },
      logCost,
    })
    canonicalPath = result.storagePath
  }

  // persist onto the avatar kv row (single source the app + worker share)
  const key = `model_avatar:${modelId}`
  const { data: row } = await supabase.from('agent_kv_settings').select('value').eq('key', key).maybeSingle()
  let avatar = {}
  try { avatar = row?.value ? JSON.parse(row.value) : {} } catch { avatar = {} }
  const next = {
    ...avatar,
    imagePaths,
    sheetPath,
    ...(canonicalPath ? { canonicalPath } : {}),
    builtAt: new Date().toISOString(),
    building: false,
  }
  const { error } = await supabase
    .from('agent_kv_settings')
    .upsert({ key, value: JSON.stringify(next) }, { onConflict: 'key' })
  if (error) throw new Error(`avatar kv persist failed: ${error.message}`)

  return { sheetPath, canonicalPath, imageCount: imagePaths.length }
}

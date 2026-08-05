/**
 * Creative Studio post-processing: gallery thumbnails.
 *
 * After an image is generated (Gemini OR FASHN) we build a small webp thumbnail so
 * the gallery grid loads fast (was loading multi-MB full-res PNGs as thumbs — owner
 * complaint "gallery slow").
 *
 * Branding (logo + product code + hook) is intentionally NOT done here. It's an
 * on-demand, PER-IMAGE step the owner runs from the Studio (the /finish route →
 * applyBrandFrame, which uses the real brand identity: logo, colours, fonts). The
 * same code/hook must not be auto-stamped on every render.
 *
 * Best-effort: any failure returns what it has and never blocks the job result — a
 * missing thumbnail must never lose the real image.
 */
import {
  inspectImageArtifact,
  inspectStoredImageArtifact,
  resolutionIntegrityFromArtifact,
  uploadImageArtifact,
} from '../image-artifact.mjs'

const THUMB_WIDTH = 480

async function getSharp() {
  return (await import('sharp')).default
}

async function downloadFromStorage(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** Build a compact webp thumbnail. Returns its traceable descriptor or null. */
export async function makeThumbnail(supabase, pendingActionId, sourceBuffer, suffix = '') {
  try {
    const sharp = await getSharp()
    const thumb = await sharp(sourceBuffer)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    return uploadImageArtifact({
      supabase,
      buffer: thumb,
      storageBasePath: `generated/thumbs/${pendingActionId}${suffix ? `-${suffix}` : ''}`,
      kind: 'thumbnail',
      contract: { mode: 'maximum-long-edge', maxLongEdge: THUMB_WIDTH },
      sourceKind: 'original',
      transformVersion: 'cse8-thumbnail-v1',
    })
  } catch (err) {
    console.warn(`[branding] thumbnail failed for ${pendingActionId}:`, err.message)
    return null
  }
}

/**
 * One-shot post-process: download the final image once and produce a thumbnail.
 * Best-effort thumbnail generation. Original inspection is mandatory: callers
 * must never publish an image whose real bytes cannot be described.
 */
export async function postProcessImage(supabase, pendingActionId, storagePath, {
  original: suppliedOriginal,
  inspectOptions = {},
} = {}) {
  const buf = await downloadFromStorage(supabase, storagePath)
  let original = suppliedOriginal
  if (!original) {
    original = buf
      ? await inspectImageArtifact(buf, { ...inspectOptions, kind: 'original', storagePath })
      : await inspectStoredImageArtifact(supabase, storagePath, { ...inspectOptions, kind: 'original' })
  }
  const thumbnail = buf ? await makeThumbnail(supabase, pendingActionId, buf) : null
  return {
    ...(thumbnail ? { thumbPath: thumbnail.storagePath } : {}),
    resolutionIntegrity: resolutionIntegrityFromArtifact(original),
    variants: {
      original,
      ...(thumbnail ? { thumbnail } : {}),
    },
  }
}

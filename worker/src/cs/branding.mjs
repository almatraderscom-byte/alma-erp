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

const THUMB_WIDTH = 480

async function getSharp() {
  return (await import('sharp')).default
}

async function downloadFromStorage(supabase, path) {
  const { data, error } = await supabase.storage.from('agent-files').download(path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

/** Build a compact webp thumbnail. Returns its storage path or null. */
export async function makeThumbnail(supabase, pendingActionId, sourceBuffer, suffix = '') {
  try {
    const sharp = await getSharp()
    const thumb = await sharp(sourceBuffer)
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    const thumbPath = `generated/thumbs/${pendingActionId}${suffix ? `-${suffix}` : ''}.webp`
    const { error } = await supabase.storage
      .from('agent-files')
      .upload(thumbPath, thumb, { contentType: 'image/webp', upsert: true })
    if (error) return null
    return thumbPath
  } catch (err) {
    console.warn(`[branding] thumbnail failed for ${pendingActionId}:`, err.message)
    return null
  }
}

/**
 * One-shot post-process: download the final image once and produce a thumbnail.
 * Best-effort — returns {} on any problem.
 */
export async function postProcessImage(supabase, pendingActionId, storagePath) {
  const out = {}
  const buf = await downloadFromStorage(supabase, storagePath)
  if (!buf) return out
  const thumbPath = await makeThumbnail(supabase, pendingActionId, buf)
  if (thumbPath) out.thumbPath = thumbPath
  return out
}

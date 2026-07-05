/**
 * Bangla caption overlays — PNG per cue, composited by ffmpeg.
 *
 * WHY not ASS burn-in: the VPS ffmpeg's libass mangles Bangla complex-script
 * shaping (reph/conjuncts break: "অর্ডার" → "অর্‌ডার", e-kar lands on the wrong
 * side — caught in the live V2 e2e). sharp's SVG renderer goes through
 * pango/harfbuzz, which shapes Bangla correctly, so each cue becomes a
 * transparent PNG strip that ffmpeg overlays for exactly its cue window.
 * Deterministic mechanics, no libass dependency. ASS stays as the fallback.
 */
import { writeFile, mkdir, copyFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts')
const SYSTEM_FONT_DIR = '/usr/local/share/fonts/alma'

/** Reference style — matches the ASS style constants app-side. */
const FONT_FAMILY = 'Noto Sans Bengali'
const REF_FONT_SIZE = 64 // at 1920-high output
const REF_MARGIN_V = 220

/**
 * Make the bundled font visible to fontconfig (pango finds fonts through it).
 * Idempotent; the worker runs as root on the VPS (no inbound SSH — provisioning
 * ships through the repo). Fails soft on dev Macs.
 */
export async function ensureBanglaFontInstalled() {
  try {
    const dest = join(SYSTEM_FONT_DIR, 'NotoSansBengali.ttf')
    try {
      await access(dest)
      return true // already installed
    } catch { /* install below */ }
    await mkdir(SYSTEM_FONT_DIR, { recursive: true })
    await copyFile(join(FONTS_DIR, 'NotoSansBengali.ttf'), dest)
    await execFileAsync('fc-cache', ['-f', SYSTEM_FONT_DIR], { timeout: 30_000 }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[worker] bangla font install failed:', err?.message)
    return false
  }
}

const escapeXml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Render caption cues as transparent full-width PNG strips.
 * Returns [{ file, start, end, height }] — empty array if sharp/pango fails
 * (caller falls back to ASS burn-in).
 */
export async function renderCaptionOverlays({ cues, output, workDir }) {
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch (err) {
    console.warn('[worker] sharp unavailable for captions:', err?.message)
    return []
  }
  await ensureBanglaFontInstalled()

  const scale = output.height / 1920
  const baseFontSize = Math.round(REF_FONT_SIZE * scale)
  const maxTextW = Math.round(output.width * 0.92)
  const overlays = []

  const renderCue = async (text, fontSize) => {
    const stripH = Math.round(fontSize * 1.9) // room for Bangla ascenders/descenders
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${stripH}">
  <text x="50%" y="${Math.round(stripH * 0.68)}" text-anchor="middle"
        font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600"
        fill="#ffffff" stroke="#202020" stroke-width="${Math.max(2, Math.round(fontSize / 16))}"
        paint-order="stroke">${escapeXml(text)}</text>
</svg>`
    // NOTE: no density option — librsvg's 72dpi baseline keeps SVG px 1:1
    // (density:96 scaled every strip 1.33× and pushed text off-frame).
    const buf = await sharp(Buffer.from(svg)).png().toBuffer()
    return { buf, stripH }
  }

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]
    let fontSize = baseFontSize
    let { buf, stripH } = await renderCue(cue.text, fontSize)

    // deterministic auto-shrink: measure the drawn text (trim to its bounding
    // box); a line wider than the frame re-renders once at the fitting size
    try {
      // toBuffer(resolveWithObject) reports the POST-trim size (metadata() would
      // return the pre-trim input dimensions)
      const { info } = await sharp(buf).trim().toBuffer({ resolveWithObject: true })
      const textW = info.width ?? 0
      if (textW > maxTextW) {
        fontSize = Math.max(24, Math.floor((fontSize * maxTextW) / textW))
        ;({ buf, stripH } = await renderCue(cue.text, fontSize))
      }
    } catch { /* keep the base render */ }

    const file = join(workDir, `cue-${i}.png`)
    await writeFile(file, buf)
    overlays.push({ file, start: cue.start, end: cue.end, height: stripH })
  }

  return overlays
}

/** Bottom margin (pixels) for the caption strip at this output size. */
export function captionMarginV(output) {
  return Math.round(REF_MARGIN_V * (output.height / 1920))
}

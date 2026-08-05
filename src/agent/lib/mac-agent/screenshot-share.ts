/**
 * One story for handing a Mac screenshot to the head, shared by every tool
 * that can produce one (`look_mac_app` app-window shots, `mac_desk_control`
 * full-screen shots).
 *
 * Never give the head the base64 body: it pastes the megabyte into its reply
 * as "markdown" and the chat renders a wall of text (hit live twice — once on
 * the L8 demo, once on the owner's own checklist run, where the desk-control
 * path still had the old shape). Upload once, return the SHORT owner-authed
 * /files link — long signed JWTs get wrapped by the head and the markdown
 * image breaks (also hit live).
 */
import {
  agentStorageDelete,
  agentStorageListFolder,
  agentStorageUpload,
} from '@/agent/lib/storage'
import sharp from 'sharp'

const MAX_BYTES = 9_500_000
const RETENTION_MS = 24 * 3600 * 1000

export type ScreenshotShareResult =
  | { ok: true; imageUrl: string; instruction: string }
  | { ok: false; retryable: true }
  | { ok: false; retryable: false; boundedText: string }

export interface ScreenshotAnnotation {
  phase: 'before' | 'after'
  /** The exact approved act, for example `Click — New chat`. */
  actionLabel: string
  /** Optional verified outcome. Never use this field for an unverified claim. */
  detail?: string | null
}

const xmlEscape = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;')

/**
 * Put a visible, truthful action marker on a screenshot.  This deliberately
 * marks the ACTION LABEL rather than guessing a pixel coordinate: the AX
 * driver resolves controls by accessibility label and does not expose a
 * trustworthy rectangle in every app build.  A guessed circle would be worse
 * than no circle.  The opaque banner survives chat thumbnailing and makes the
 * before/after pair self-explanatory outside the live dock too.
 */
export async function annotateScreenshot(
  rawStdout: string,
  annotation: ScreenshotAnnotation,
): Promise<string | null> {
  const uri = String(rawStdout ?? '')
  const match = uri.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  try {
    const input = Buffer.from(match[2], 'base64')
    const metadata = await sharp(input).metadata()
    const width = metadata.width ?? 1200
    const bannerHeight = Math.max(86, Math.min(126, Math.round(width * 0.075)))
    const phase = annotation.phase === 'before' ? 'BEFORE' : 'AFTER'
    const color = annotation.phase === 'before' ? '#F59E0B' : '#22C55E'
    const title = xmlEscape(annotation.actionLabel.slice(0, 110))
    const detail = annotation.detail ? xmlEscape(annotation.detail.slice(0, 130)) : ''
    const titleY = detail ? Math.round(bannerHeight * 0.46) : Math.round(bannerHeight * 0.62)
    const svg = Buffer.from(
      `<svg width="${width}" height="${bannerHeight}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${width}" height="${bannerHeight}" fill="#08111F" fill-opacity="0.92"/>` +
      `<rect width="${Math.max(8, Math.round(width * 0.009))}" height="${bannerHeight}" fill="${color}"/>` +
      `<rect x="${Math.round(width * 0.025)}" y="${Math.round(bannerHeight * 0.21)}" rx="9" ` +
      `width="${Math.max(92, Math.round(width * 0.105))}" height="${Math.round(bannerHeight * 0.56)}" fill="${color}"/>` +
      `<text x="${Math.round(width * 0.077)}" y="${Math.round(bannerHeight * 0.59)}" text-anchor="middle" ` +
      `font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.max(18, Math.round(width * 0.018))}" font-weight="800" fill="#07111F">${phase}</text>` +
      `<text x="${Math.round(width * 0.15)}" y="${titleY}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" ` +
      `font-size="${Math.max(20, Math.round(width * 0.021))}" font-weight="700" fill="#FFFFFF">${title}</text>` +
      (detail
        ? `<text x="${Math.round(width * 0.15)}" y="${Math.round(bannerHeight * 0.79)}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.max(16, Math.round(width * 0.016))}" fill="#CBD5E1">${detail}</text>`
        : '') +
      '</svg>',
    )
    const bytes = await sharp(input)
      .composite([{ input: svg, top: 0, left: 0 }])
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer()
    if (!bytes.length || bytes.length > MAX_BYTES) return null
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * How should run_mac_command treat a command that involves `screencapture`?
 *
 * NOT by parsing shell — that is an arms race this helper refuses to enter
 * (Codex found escaped quotes, comments and wrapper options in three rounds;
 * a "parser" here would never be sh). Instead, two zero-ambiguity buckets:
 *
 *   'intercept' — a SIMPLE command (no quoting/chaining/comment characters at
 *                 all) whose first executable, by basename after env
 *                 assignments and bare wrappers, is screencapture. Nothing to
 *                 mis-parse — absorb it into the real screenshot flow.
 *   'refuse'    — anything COMPOUND that mentions screencapture anywhere.
 *                 Run nothing, capture nothing: a wrong capture would expose
 *                 the owner's screen and a wrong run leaves an invisible
 *                 file, so the only safe deterministic answer is an honest
 *                 refusal that names the right tool.
 *   'run'       — everything else: the normal command path.
 */
export function classifyScreencaptureIntent(command: string): 'intercept' | 'refuse' | 'run' {
  const c = String(command)
  if (!/screencapture/i.test(c)) return 'run'
  // Only printable ASCII qualifies as "simple": JS \s treats characters as
  // whitespace that zsh does NOT split on (NBSP et al.), so a command
  // containing any exotic character refuses rather than being tokenized
  // differently from the shell that would run it (Codex P1).
  const simple = !/[;&|'"`#\n$(){}<>\\]/.test(c) && !/[^\x20-\x7e]/.test(c)
  if (simple) {
    const words = c.trim().split(/[ \t]+/).filter(Boolean)
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
    const baseOf = (w: string) => (w.split('/').pop() ?? '').toLowerCase()
    // First word IS screencapture (path-qualified or not): unambiguous.
    if (baseOf(words[i] ?? '') === 'screencapture') {
      // Flag ALLOWLIST, not a scope blocklist (Codex kept finding scope
      // letters: -l, -R, -w, -s…): only silent/cosmetic output flags are
      // known-safe to absorb into a full-screen shot. Anything else — scoped,
      // interactive, unknown — refuses rather than silently WIDENING what
      // the model asked to capture.
      const unsafe = words.slice(i + 1).some((w) => w.startsWith('-') && !/^-[xCt]+$/.test(w))
      return unsafe ? 'refuse' : 'intercept'
    }
    // The word appears as its own token anywhere else — wrapper forms
    // (sudo/env/command …), lookups, whatever: there is NO wrapper parser
    // here on purpose (five review rounds proved that parser would never be
    // sh — options with operands, lookup modes, path-qualified wrappers…).
    // Refuse: nothing runs, nothing is captured, the message names the
    // right tool and how to rephrase.
    if (words.some((w) => baseOf(w) === 'screencapture')) return 'refuse'
    return 'run' // plain word inside a filename etc. — `cat notes/screencapture.md`
  }
  return 'refuse'
}

export async function shareScreenshot(
  rawStdout: string,
  commandId: string,
  label: string,
): Promise<ScreenshotShareResult> {
  const uri = String(rawStdout ?? '')
  const m = uri.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/)
  if (!m) {
    // Unexpected daemon payload — bounded passthrough, never a megabyte.
    return { ok: false, retryable: false, boundedText: uri.slice(0, 4_000) }
  }
  try {
    const bytes = Buffer.from(m[2], 'base64')
    // Size gate BEFORE the upload — an oversized body must never reach the
    // bucket in the first place.
    if (!bytes.length || bytes.length > MAX_BYTES) {
      return { ok: false, retryable: true }
    }
    const ext = m[1] === 'png' ? 'png' : 'jpg'
    // Timestamp in the name is the retention key — the folder self-cleans on
    // use (below); there is deliberately no cron for this bucket.
    const objectPath = `mac-ui/shot-${Date.now()}-${commandId}.${ext}`
    await agentStorageUpload(objectPath, bytes, `image/${m[1]}`)
    try {
      const dayAgo = Date.now() - RETENTION_MS
      const stale = (await agentStorageListFolder('mac-ui/')).filter((f) => {
        const ts = Number(/^shot-(\d+)-/.exec(f.name)?.[1])
        return Number.isFinite(ts) && ts < dayAgo
      })
      if (stale.length) await agentStorageDelete(stale.map((f) => `mac-ui/${f.name}`))
    } catch {
      /* retention is best-effort; next capture retries */
    }
    // Absolute: the same reply may land in Telegram, where a root-relative
    // path has no origin. Short and stable: nothing for the head to mangle.
    const base = (
      process.env.APP_URL ||
      process.env.NEXTAUTH_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      'https://alma-erp-six.vercel.app'
    ).replace(/\/$/, '')
    const imageUrl = `${base}/api/assistant/files?path=${encodeURIComponent(objectPath)}&redirect=1`
    return {
      ok: true,
      imageUrl,
      instruction:
        'ছবিটা ওনারকে দেখাতে markdown image হিসেবে দাও, এক লাইনে: ![' + label + '](imageUrl)। ' +
        'imageUrl হুবহু কপি করো — ছোট লিংক, ভাঙার কিছু নেই। base64 বা লম্বা টেক্সট কখনো লিখবে না।',
    }
  } catch {
    return { ok: false, retryable: true }
  }
}

/** Annotate first, then use the one canonical storage/share path. */
export async function shareAnnotatedScreenshot(
  rawStdout: string,
  commandId: string,
  annotation: ScreenshotAnnotation,
): Promise<ScreenshotShareResult> {
  const annotated = await annotateScreenshot(rawStdout, annotation)
  if (!annotated) return { ok: false, retryable: true }
  return shareScreenshot(
    annotated,
    commandId,
    `${annotation.phase === 'before' ? 'Before' : 'After'} — ${annotation.actionLabel}`,
  )
}

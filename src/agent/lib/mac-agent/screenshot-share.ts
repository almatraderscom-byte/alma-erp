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

const MAX_BYTES = 9_500_000
const RETENTION_MS = 24 * 3600 * 1000

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
  const simple = !/[;&|'"`#\n$(){}<>\\]/.test(c)
  if (simple) {
    const words = c.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
    const baseOf = (w: string) => (w.split('/').pop() ?? '').toLowerCase()
    // First word IS screencapture (path-qualified or not): unambiguous.
    if (baseOf(words[i] ?? '') === 'screencapture') {
      // SCOPED or interactive capture (-l window, -R rect, -w/-W pick, -i):
      // absorbing it into a FULL-screen shot would WIDEN what the model asked
      // to capture (Codex P1). Refuse with guidance instead — app-window
      // shots belong to look_mac_app.
      const scoped = words.slice(i + 1).some((w) => /^-[A-Za-z]*[lRwWiU]/.test(w))
      return scoped ? 'refuse' : 'intercept'
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
): Promise<
  | { ok: true; imageUrl: string; instruction: string }
  | { ok: false; retryable: true }
  | { ok: false; retryable: false; boundedText: string }
> {
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

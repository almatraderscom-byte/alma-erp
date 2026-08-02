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

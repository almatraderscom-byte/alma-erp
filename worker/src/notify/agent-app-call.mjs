/**
 * Worker-side bridge to the in-app agent call (plan C4): the VPS asks Vercel to
 * VoIP-ring the owner's app. Used by the salah scheduler when the owner-abroad
 * toggle is on (BD number unreachable → the app still rings, worldwide).
 * Fail-open: any error returns ok:false and the caller falls back to push-only.
 */
import { getAppUrl, getInternalToken } from '../env.mjs'

export async function ringOwnerAppViaWeb(purpose, source = 'salah') {
  try {
    const base = getAppUrl()
    const token = getInternalToken()
    if (!base || !token) return { ok: false, error: 'app url/token missing' }
    const res = await fetch(`${base}/api/assistant/internal/agent-app-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ purpose, source }),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error ?? `HTTP ${res.status}` }
    }
    return { ok: true, callId: data.callId }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

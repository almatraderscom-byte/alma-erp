import { createHmac, timingSafeEqual } from 'crypto'

function secret(): string {
  return process.env.AGENT_INTERNAL_TOKEN ?? process.env.TWILIO_AUTH_TOKEN ?? ''
}

export function signAudioPath(storagePath: string, expMs: number): string {
  return createHmac('sha256', secret()).update(`${storagePath}:${expMs}`).digest('hex')
}

export function verifyAudioToken(storagePath: string, expMs: number, token: string): boolean {
  if (!token || !storagePath || !Number.isFinite(expMs)) return false
  if (Date.now() > expMs) return false
  const expected = signAudioPath(storagePath, expMs)
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function buildProxiedAudioUrl(appUrl: string, storagePath: string, ttlSec = 900): string {
  const exp = Date.now() + ttlSec * 1000
  const t = signAudioPath(storagePath, exp)
  const base = appUrl.replace(/\/$/, '')
  const params = new URLSearchParams({
    path: storagePath,
    exp: String(exp),
    t,
  })
  return `${base}/api/twilio/audio?${params.toString()}`
}

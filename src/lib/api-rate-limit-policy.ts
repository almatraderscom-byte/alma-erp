export interface ApiRateLimitPolicy {
  bucket: string
  limit: number
}

// These routes authenticate a paired device bearer in their own handler and
// run continuously. Per-path buckets prevent Mac + Chrome behind one NAT from
// exhausting the generic owner/API bucket. 720/min allows several paired
// devices at the shipped 0.6–1s frame cadence while retaining a bounded edge
// backstop; pair-code and owner-session endpoints intentionally stay generic.
const HIGH_FREQUENCY_DEVICE_PATHS = new Set([
  '/api/assistant/live-browser/poll',
  '/api/assistant/live-browser/authorize',
  '/api/assistant/live-browser/result',
  '/api/assistant/live-browser/frames',
  '/api/assistant/mac-agent/poll',
  '/api/assistant/mac-agent/result',
  '/api/assistant/mac-agent/events',
  '/api/assistant/mac-agent/frames',
  '/api/assistant/mac-agent/screen-video-token',
])

export function apiRateLimitPolicy(pathname: string): ApiRateLimitPolicy {
  if (pathname === '/api/auth/session') return { bucket: 'auth-session', limit: 120 }
  if (pathname.startsWith('/api/auth')) return { bucket: 'auth', limit: 40 }
  if (HIGH_FREQUENCY_DEVICE_PATHS.has(pathname)) {
    return { bucket: `device-api:${pathname}`, limit: 720 }
  }
  return { bucket: 'api', limit: 180 }
}

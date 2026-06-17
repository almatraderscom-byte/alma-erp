/**
 * Server-to-server auth for VPS worker / Telegram bridge → /api/assistant/*.
 * Used by middleware (Edge-safe) and may be imported by route handlers.
 */

export function extractBearerToken(authHeader: string | null | undefined): string {
  const header = authHeader ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** Constant-time compare — Edge middleware compatible (no node:crypto). */
export function verifyAgentInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

/** Paths the Telegram worker hits with AGENT_INTERNAL_TOKEN (no browser session). */
export function isAssistantWorkerBypassPath(pathname: string): boolean {
  if (pathname === '/api/assistant/chat') return true
  if (pathname === '/api/assistant/conversations') return true
  if (pathname === '/api/assistant/todos') return true
  if (pathname === '/api/assistant/internal/day-shift') return true
  if (/^\/api\/assistant\/actions\/[^/]+\/(approve|reject)$/.test(pathname)) return true
  if (/^\/api\/assistant\/actions\/[^/]+$/.test(pathname)) return true
  return false
}

export function isAssistantWorkerRequest(pathname: string, authHeader: string | null | undefined): boolean {
  if (!isAssistantWorkerBypassPath(pathname)) return false
  return verifyAgentInternalToken(extractBearerToken(authHeader))
}

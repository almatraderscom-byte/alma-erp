import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'

export function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function internalAuthHeaders(authHeader: string | null): Response | null {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

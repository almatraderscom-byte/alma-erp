import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { HERMES_VPS_IP } from '@/lib/agent-api/constants'

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return req.headers.get('x-real-ip')?.trim() || 'unknown'
}

/**
 * Restrict /api/agent/* to Hermes VPS when AGENT_IP_ALLOWLIST=true (default in production).
 * Disabled in development and when env explicitly set to false.
 */
export function requireAgentIp(req: NextRequest): NextResponse | null {
  const enforce =
    process.env.AGENT_IP_ALLOWLIST === 'true' ||
    (process.env.NODE_ENV === 'production' && process.env.AGENT_IP_ALLOWLIST !== 'false')
  if (!enforce) return null

  const ip = clientIp(req)
  const extra = (process.env.AGENT_IP_ALLOWLIST_EXTRA ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const allowed = new Set([HERMES_VPS_IP, ...extra])
  if (allowed.has(ip) || ip === '127.0.0.1' || ip === '::1') return null

  return NextResponse.json({ error: 'Forbidden — IP not allowlisted' }, { status: 403 })
}

/**
 * GET /api/assistant/internal/marketing-health
 *
 * Phase 41 — read-only marketing capability matrix + measurement health.
 * Secrets are redacted; env presence alone never shows green. No external
 * writes happen here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runCapabilityAudit } from '@/agent/lib/marketing/capability-audit'
import { assessMeasurementHealth } from '@/agent/lib/marketing/measurement-health'

export const runtime = 'nodejs'
export const maxDuration = 120

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const windowDays = Math.min(Math.max(Number(req.nextUrl.searchParams.get('days') ?? 7), 1), 30)

  const [capabilities, measurement] = await Promise.all([
    runCapabilityAudit(),
    assessMeasurementHealth(windowDays).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
    })),
  ])

  return NextResponse.json({
    ok: true,
    capabilities,
    measurement,
    note: 'Read-only audit. Statuses are probe-proven; unknown/broken/unsupported are honest states, not failures to hide.',
  })
}

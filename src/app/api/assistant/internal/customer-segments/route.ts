/**
 * GET /api/assistant/internal/customer-segments
 * Customer win-back / loyalty segments for worker weekly digest.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { segmentCustomersForApi } from '@/lib/customer-intelligence'
import { buildCustomerLifetimeDigest, persistCustomerLifetimeKnowledge } from '@/lib/customer-lifetime'
import { trackWinbackCohort } from '@/lib/outcome-wiring'

export const runtime = 'nodejs'

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
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const [segments, lifetime] = await Promise.all([
      segmentCustomersForApi(),
      buildCustomerLifetimeDigest(),
    ])
    if (segments.winBack?.length) {
      void trackWinbackCohort(segments.winBack).catch(() => {})
    }
    void persistCustomerLifetimeKnowledge().catch(() => {})
    return NextResponse.json({ ...segments, lifetime })
  } catch (err) {
    console.error('[customer-segments] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to segment customers' }, { status: 500 })
  }
}

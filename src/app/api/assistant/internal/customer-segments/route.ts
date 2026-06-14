/**
 * GET /api/assistant/internal/customer-segments
 * Customer win-back / loyalty segments for worker weekly digest.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { segmentCustomersForApi } from '@/lib/customer-intelligence'

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
    const segments = await segmentCustomersForApi()
    return NextResponse.json(segments)
  } catch (err) {
    console.error('[customer-segments] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to segment customers' }, { status: 500 })
  }
}

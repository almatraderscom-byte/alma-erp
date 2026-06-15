/**
 * POST /api/assistant/internal/ads-optimizer-exec
 * Queue one recommendation from batch gate → individual confirm card.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { executeAdsOptimizerRec } from '@/agent/lib/ads/optimizer'

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

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { gateId?: string; recIndex?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const gateId = String(body.gateId ?? '').trim()
  const recIndex = Number(body.recIndex)
  if (!gateId || !Number.isFinite(recIndex)) {
    return NextResponse.json({ error: 'gateId and recIndex required' }, { status: 400 })
  }

  try {
    const exec = await executeAdsOptimizerRec(gateId, recIndex)
    return NextResponse.json({ success: true, ...exec })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}

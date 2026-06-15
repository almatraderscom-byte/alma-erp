/**
 * POST /api/assistant/internal/ads-optimizer-run
 * Daily scheduler + manual trigger for ad optimization batch card.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { createAdsOptimizerBatchCard } from '@/agent/lib/ads/optimizer'

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
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!checkToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const batch = await createAdsOptimizerBatchCard()
    if (!batch) {
      return NextResponse.json({
        success: true,
        skipped: true,
        message: 'No actionable recommendations — all hold or no campaigns.',
      })
    }
    return NextResponse.json({
      success: true,
      gateId: batch.gateId,
      actionableCount: batch.actionableCount,
      summary: batch.summary,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

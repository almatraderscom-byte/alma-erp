/**
 * GET /api/assistant/internal/order-issues
 * Order health scan for VPS worker scheduler + agent tools.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { detectOrderIssues } from '@/lib/order-monitor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

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
  if (!checkToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const issues = await detectOrderIssues()
    return NextResponse.json({
      ok: true,
      count: issues.length,
      issues,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[order-issues] failed:', err)
    return NextResponse.json({ error: 'Failed to scan orders' }, { status: 500 })
  }
}

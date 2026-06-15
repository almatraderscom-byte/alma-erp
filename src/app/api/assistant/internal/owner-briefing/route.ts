/**
 * GET /api/assistant/internal/owner-briefing
 * Structured owner morning briefing data for the VPS worker scheduler.
 * Includes unified digest extras (todos, approvals, website health).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import type { OwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { buildOwnerDailyDigest } from '@/lib/owner-daily-digest'

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

function emptyBriefing(): OwnerBriefingData {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  return {
    today,
    sales: null,
    pendingOrders: null,
    inventory: null,
    reorderSuggestions: [],
    csWaiting: null,
    adsDigest: null,
    staffYesterday: null,
    staffPatterns: [],
    returns: null,
    pricing: null,
    orderIssues: [],
    decisions: [],
    ownerDecisionMemoryCount: 0,
    generatedAt: new Date().toISOString(),
    marketingSeasons: [],
    marketingIntel: null,
  }
}

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const digest = await buildOwnerDailyDigest()
    const business = (digest.business as OwnerBriefingData | null) ?? emptyBriefing()
    return NextResponse.json({
      ...business,
      websiteHealth: digest.websiteHealth,
      pendingApprovalsCount: digest.pendingApprovalsCount,
      openTodos: digest.openTodos,
      lingeringTodos: digest.lingeringTodos,
      healthScan: digest.healthScan,
    })
  } catch (err) {
    console.error('[owner-briefing] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to build briefing' }, { status: 500 })
  }
}

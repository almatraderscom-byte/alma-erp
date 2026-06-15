/**
 * POST /api/assistant/internal/ad-creative-gate
 * Regenerate one ad creative variant at the approval gate.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import {
  buildAdCreativeKeyboard,
  regenerateAdCreativeItem,
} from '@/lib/content-engine/ad-creative-gate'
import { prisma } from '@/lib/prisma'

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

  let body: { gateId?: string; creativeId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const gateId = String(body.gateId ?? '').trim()
  const creativeId = String(body.creativeId ?? '').trim()
  if (!gateId || !creativeId) {
    return NextResponse.json({ error: 'gateId and creativeId required' }, { status: 400 })
  }

  try {
    const { summary } = await regenerateAdCreativeItem(gateId, creativeId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = await (prisma as any).agentPendingAction.findUnique({ where: { id: gateId } })
    const payload = gate?.payload ?? {}
    const keyboard = buildAdCreativeKeyboard(gateId, payload)
    return NextResponse.json({ success: true, summary, keyboard })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}

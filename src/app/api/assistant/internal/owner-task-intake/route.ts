/**
 * POST /api/assistant/internal/owner-task-intake
 * Evening Sir-task intake (worker scheduler @ 20:30 Dhaka).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runOwnerTaskIntakeSend } from '@/agent/lib/owner-task-intake'

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
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await runOwnerTaskIntakeSend()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[owner-task-intake] failed:', err)
    return NextResponse.json({ error: 'Failed to send intake' }, { status: 500 })
  }
}

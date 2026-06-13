/**
 * POST /api/assistant/internal/staff-announcement
 * Queues a staff announcement (text + optional voice) — no task tracking.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function POST(req: NextRequest) {
  if (!checkToken(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: {
    message?: string
    staffChatIds?: Array<{ id: string; name: string; chatId: string }>
    sendVoice?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const message = String(body.message ?? '').trim()
  const staffChatIds = (body.staffChatIds ?? []).filter((s) => s?.chatId)

  if (!message || !staffChatIds.length) {
    return NextResponse.json({ error: 'message and staffChatIds required' }, { status: 400 })
  }

  try {
    const action = await db.agentPendingAction.create({
      data: {
        type: 'staff_announcement',
        payload: {
          message,
          staffChatIds,
          sendVoice: body.sendVoice !== false,
        },
        summary: `📢 স্টাফ ঘোষণা (${staffChatIds.length} জন)`,
        costEstimate: 0,
        status: 'approved',
      },
    })

    return NextResponse.json({ status: 'queued', actionId: action.id })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

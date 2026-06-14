/**
 * POST /api/assistant/internal/compact-conversation
 * Summarizes a conversation and creates a new one seeded with the summary.
 * Auth: internal token (worker) OR session (web owner).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { compactConversationById } from '@/agent/lib/conversation-compact'

export const runtime = 'nodejs'
export const maxDuration = 60

function checkInternalToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const isInternal = checkInternalToken(req)
  if (!isInternal) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub || !isSystemOwner(token)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  let body: { conversationId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const conversationId = body.conversationId
  if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

  try {
    const result = await compactConversationById(conversationId)
    return NextResponse.json({ newConversationId: result.newConversationId, summary: result.summary })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (msg === 'summary_empty') return NextResponse.json({ error: 'summary_empty' }, { status: 422 })
    console.error('[compact-conversation]', err)
    return NextResponse.json({ error: 'compact_failed' }, { status: 500 })
  }
}

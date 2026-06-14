/**
 * POST /api/assistant/internal/build-knowledge
 * Nightly knowledge graph build from real ERP data + outcome learnings.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildBusinessKnowledge } from '@/lib/knowledge-build'

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
    const result = await buildBusinessKnowledge()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[build-knowledge]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

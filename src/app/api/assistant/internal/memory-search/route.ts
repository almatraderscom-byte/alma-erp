/**
 * POST /api/assistant/internal/memory-search
 * Semantic memory search for worker schedulers (owner decisions, etc.).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { searchAgentMemory } from '@/agent/lib/memory-search'

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

  let body: { query?: string; scope?: string; limit?: number; metadataType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  const memories = await searchAgentMemory({
    query,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    limit: typeof body.limit === 'number' ? body.limit : 8,
    metadataType: typeof body.metadataType === 'string' ? body.metadataType : undefined,
  })

  return NextResponse.json({ memories })
}

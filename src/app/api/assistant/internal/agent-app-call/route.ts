/**
 * Internal ring primitive (plan C1): the VPS worker (salah scheduler) and any
 * server-side caller ask Vercel to ring the owner's app with a VoIP push.
 * Auth: Bearer AGENT_INTERNAL_TOKEN (same contract as native-push).
 *
 * POST { purpose, source? }        → { ok, callId } | { ok:false, error }
 * GET  ?id=<callId>                → { status }  (lazy unanswered sweep inside)
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  ringOwnerApp,
  getAgentAppCallStatus,
  type AgentAppCallSource,
} from '@/agent/lib/agent-app-call'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function authorized(req: NextRequest): boolean {
  const h = req.headers.get('authorization') ?? ''
  return verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '')
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: { purpose?: unknown; source?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : ''
  if (!purpose) return Response.json({ error: 'purpose required' }, { status: 400 })
  const source: AgentAppCallSource =
    body.source === 'salah' || body.source === 'manual' ? body.source : 'ladder'

  const result = await ringOwnerApp({ purpose, source })
  return Response.json(result, { status: result.ok ? 200 : 502 })
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })
  const status = await getAgentAppCallStatus(id)
  if (!status) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ status })
}

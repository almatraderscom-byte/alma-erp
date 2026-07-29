/**
 * App-side status leg of an agent → owner in-app call (plan C1/C2).
 * The iOS/Android app posts here from the CallKit answer/decline/hangup path
 * using the owner's own session cookie (same auth as the rest of the app).
 *
 * POST { status: 'answered' | 'declined' | 'completed', summary? }
 * GET  → { status, purpose }   (the app fetches the brief while connecting)
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  getAgentAppCallStatus,
  getAgentAppCallBrief,
  markAgentAppCall,
} from '@/agent/lib/agent-app-call'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return { error: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!isSystemOwner(token)) return { error: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { ok: true as const }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  const [status, brief] = await Promise.all([
    getAgentAppCallStatus(params.id),
    getAgentAppCallBrief(params.id),
  ])
  if (!status || !brief) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ status, purpose: brief.purpose, source: brief.source })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireOwner(req)
  if ('error' in auth && auth.error) return auth.error

  let body: { status?: unknown; summary?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const status = body.status
  if (status !== 'answered' && status !== 'declined' && status !== 'completed') {
    return Response.json({ error: 'status must be answered|declined|completed' }, { status: 400 })
  }
  const summary = typeof body.summary === 'string' ? body.summary : undefined
  const ok = await markAgentAppCall(params.id, status, summary)
  if (!ok) {
    // Not an error worth failing the app over — the row may already be swept.
    const current = await getAgentAppCallStatus(params.id)
    return Response.json({ ok: false, status: current ?? 'not_found' }, { status: 409 })
  }
  return Response.json({ ok: true, status })
}

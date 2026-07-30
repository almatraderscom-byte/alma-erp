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
import { prisma } from '@/lib/prisma'
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

  let body: { status?: unknown; summary?: unknown; note?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const status = body.status
  const noteOnly = typeof body.note === 'string' && typeof body.status !== 'string'
  if (!noteOnly && status !== 'answered' && status !== 'declined' && status !== 'completed') {
    return Response.json({ error: 'status must be answered|declined|completed' }, { status: 400 })
  }
  // `note` carries an on-device diagnostic (e.g. why live audio never started).
  // TestFlight builds have no console access, so without this a device-only
  // failure is invisible on the server and can only be guessed at — which is
  // exactly what cost the owner two broken builds (89, 90).
  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined
  const summary = typeof body.summary === 'string'
    ? body.summary
    : note
      ? `[device] ${note}`
      : undefined
  if (note) {
    console.warn('[agent-call] device note', params.id, note)
    // Written DIRECTLY, never through the status transition: a diagnostic must
    // land whatever the row's state is (review-bot P2 — routing it through an
    // 'answered' transition 409'd on an already-answered row and dropped the
    // note, defeating the whole point).
    await prisma.agentAppCall.update({
      where: { id: params.id },
      data: { summary: `[device] ${note}` },
    }).catch(() => {})
    if (noteOnly) return Response.json({ ok: true, noteSaved: true })
  }
  const ok = await markAgentAppCall(params.id, status as 'answered' | 'declined' | 'completed', summary)
  if (!ok) {
    // Not an error worth failing the app over — the row may already be swept.
    const current = await getAgentAppCallStatus(params.id)
    return Response.json({ ok: false, status: current ?? 'not_found' }, { status: 409 })
  }
  return Response.json({ ok: true, status })
}

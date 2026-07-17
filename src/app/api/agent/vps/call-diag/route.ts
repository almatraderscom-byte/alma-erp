/**
 * Call forensics — Twilio's own verdict on one call SID, read through the worker.
 *
 * Why this exists: when a call reaches the owner as an "instant missed call", our own
 * records are useless — `agent_pending_actions.result` only ever says `no-answer,
 * duration 0`, which is ALSO what a genuinely unanswered 45-second ring looks like,
 * and what a call the owner deliberately rejects looks like. The three are
 * indistinguishable without Twilio's start/end times and Debugger alerts, and the
 * Twilio credentials live only on the VPS worker. This route reaches them without
 * copying secrets into Vercel.
 *
 * Owner-only. Read-only: it dials nothing and changes nothing.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const sid = req.nextUrl.searchParams.get('sid')?.trim()
  if (!sid || !/^CA[0-9a-f]{32}$/i.test(sid)) {
    return Response.json({ error: 'bad_sid', message: 'Pass ?sid=CA… (a Twilio call SID)' }, { status: 400 })
  }

  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN
  if (!workerUrl || !internalToken) {
    return Response.json(
      { error: 'config_missing', message: 'AGENT_WORKER_DIAGNOSTIC_URL / AGENT_INTERNAL_TOKEN not set' },
      { status: 503 },
    )
  }

  try {
    const res = await fetch(`${workerUrl}/twilio-status?sid=${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${internalToken}` },
      signal: AbortSignal.timeout(20_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return Response.json({ error: 'worker_error', status: res.status, data }, { status: 502 })
    }
    return Response.json(data)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: 'worker_unreachable', message: msg }, { status: 502 })
  }
}

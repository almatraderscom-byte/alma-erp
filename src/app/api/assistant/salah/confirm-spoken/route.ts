import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'
import { isSpokenSalahDeclaration } from '@/agent/lib/salah-confirm-intent'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

/**
 * Live-call parity for the chat path's deterministic salah auto-mark.
 *
 * On a live voice call the owner's confirmation ("নামাজ পড়েছি") only reached
 * the database if the Live model chose to call run_agent_turn — on the
 * 2026-08-15 salah call it never did, the head was never invoked, and Isha
 * stayed pending. Chat solved this class long ago: the server persists the
 * owner's own words BEFORE any model decides anything (salah-auto-mark.ts).
 * This route gives the native app that same guarantee: it posts the finalized
 * input transcript whenever it hears a prayer declaration, and the server-side
 * detectors (confirm/qaza/missed + waqt-window guards) decide what, if
 * anything, to mark. The model's tool call remains welcome — auto-mark upserts
 * are idempotent and a later mark_salah finds the waqt already settled.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { text?: unknown }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return Response.json({ error: 'text_required' }, { status: 400 })

  // Codex P1 (PR #762): a question, request, or future intent about salah
  // ("কাযা নামাজের নিয়ম বলো", "…reminder তৈরি করো", "পরে পড়ব") must never
  // reach the auto-mark writer from this path.
  if (!isSpokenSalahDeclaration(text)) {
    return Response.json({ success: true, marked: [] })
  }

  // allowSettledCorrection: on a call, the owner's LATER words win — "I
  // prayed Isha" then "no, I missed Isha" must land as missed (Codex P1
  // round 5); requests are serialized client-side in transcript order.
  const result = await applySalahAutoMarkFromUserTexts(
    [text.slice(0, 500)],
    new Date(),
    { allowSettledCorrection: true },
  )
  return Response.json({ success: true, marked: result.marked })
}

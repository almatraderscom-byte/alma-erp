/**
 * POST /api/assistant/internal/salah-delay   { waqt?, minutes?, date? }
 *
 * Internal (worker) endpoint the Telegram bot calls when the owner taps "🕐 পরে পড়বো"
 * (or otherwise asks to delay). The write runs HERE on the web (Vercel) via the shared
 * applySalahDelay engine, so it reliably persists BOTH the per-waqt override AND the
 * global owner-call-lock — the worker's own supabase write for this was unreliable, so
 * the button never actually paused calls (owner report + DB showed zero button rows).
 *
 * Internal-token auth only (same Bearer AGENT_INTERNAL_TOKEN as the other worker
 * endpoints). Returns whether a lock was actually placed + the resume label, so the bot
 * confirms TRUTHFULLY (never "বন্ধ রাখলাম" unless it really locked).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { applySalahDelay, resolveActiveSalahWaqt } from '@/agent/lib/salah-delay'

export const runtime = 'nodejs'

const DEFAULT_DELAY_MIN = 20

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

  let body: { waqt?: unknown; minutes?: unknown; date?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined
  const rawMin = Number(body.minutes)
  const minutes = Number.isFinite(rawMin) && rawMin >= 1 ? Math.round(rawMin) : DEFAULT_DELAY_MIN

  // Prefer the waqt the bot sent; otherwise infer the one whose duty window is live now.
  let waqt = typeof body.waqt === 'string' && body.waqt ? body.waqt : null
  if (!waqt) {
    const active = await resolveActiveSalahWaqt(new Date(), date)
    waqt = active?.waqt ?? null
  }
  if (!waqt) {
    return NextResponse.json({
      ok: true,
      locked: false,
      reply: 'এখন নামাজের সময়-উইন্ডোর বাইরে — এই মুহূর্তে বন্ধ করার কিছু নেই। নামাজ পড়ে "পড়েছি" জানাবেন। 🤲',
    })
  }

  const res = await applySalahDelay({ waqt, minutes, dateYmd: date, reason: 'owner pressed পরে পড়বো' })
  if (!res) {
    return NextResponse.json({
      ok: true,
      locked: false,
      reply: 'এখন duty-window-এর বাইরে — বন্ধ করা গেল না। নামাজের সময় শেষের আগে পড়ে নেবেন ইনশাআল্লাহ। 🤲',
    })
  }

  return NextResponse.json({
    ok: true,
    locked: true,
    waqt: res.waqt,
    grantedMin: res.grantedMin,
    resumeAt: res.resumeAt,
    resumeAtLabel: res.resumeAtLabel,
    reply: `ঠিক আছে Sir — ${res.grantedMin} মিনিট নামাজের কল ও রিমাইন্ডার বন্ধ রাখলাম (${res.resumeAtLabel}-এ আবার মনে করিয়ে দেব)। সময় শেষের আগে পড়ে নেবেন।`,
  })
}

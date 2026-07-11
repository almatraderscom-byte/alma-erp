/**
 * POST /api/assistant/internal/salah-snooze   { waqt, minutes, date? }
 *
 * Internal (worker) endpoint the Telegram bot calls when the owner picks
 * "১৫ মিনিট" / "৩০ মিনিট" under "🕐 পরে পড়বো". The write runs HERE on the web
 * (Vercel) via applySalahButtonSnooze, so it reliably persists the per-waqt
 * override + global owner-call-lock + follow-up state (the worker's own supabase
 * write for the lock was unreliable — same reason salah-delay lives here).
 *
 * Snooze is allowed from prayer − 15 min until the WAQT END, repeatable for 15
 * min; 30 min is once per waqt/day. Returns whether it locked + resume label so
 * the bot confirms TRUTHFULLY, and thirtyUsed so it can re-offer the right buttons.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { applySalahButtonSnooze } from '@/agent/lib/salah-snooze'
import { WAQT_LABELS } from '@/lib/salah/time-config-shared'

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
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { waqt?: unknown; minutes?: unknown; date?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : undefined
  const waqt = typeof body.waqt === 'string' && body.waqt ? body.waqt : null
  const minutes = Number(body.minutes) === 30 ? 30 : 15
  if (!waqt) return NextResponse.json({ error: 'waqt_required' }, { status: 400 })

  const name = WAQT_LABELS[waqt as keyof typeof WAQT_LABELS] ?? waqt
  const res = await applySalahButtonSnooze({ waqt, minutes, dateYmd: date })

  if (res.ok) {
    return NextResponse.json({
      ok: true,
      locked: true,
      thirtyUsed: minutes === 30,
      waqt: res.waqt,
      minutes: res.minutes,
      grantedMin: res.grantedMin,
      resumeAt: res.resumeAt,
      resumeAtLabel: res.resumeAtLabel,
      reply:
        `ঠিক আছে Sir — ${res.grantedMin} মিনিট নামাজের কল ও রিমাইন্ডার বন্ধ রাখলাম ` +
        `(${res.resumeAtLabel}-এ আবার মনে করিয়ে দেব)। ${name}-এর সময় শেষের আগে পড়ে নেবেন। 🤲`,
    })
  }

  if (res.reason === 'thirty_used') {
    return NextResponse.json({
      ok: true,
      locked: false,
      thirtyUsed: true,
      reply:
        `Sir, ৩০ মিনিট এই ওয়াক্তে একবারই নেওয়া যায় — সেটা এই ${name}-এ শেষ হয়ে গেছে। ` +
        `এখন থেকে ১৫ মিনিট করে নিতে পারবেন।`,
    })
  }

  // outside_window / no_schedule — truthful, do NOT claim a lock.
  return NextResponse.json({
    ok: true,
    locked: false,
    thirtyUsed: res.thirtyUsed,
    reply:
      `এখন ${name}-এর সময়-উইন্ডোর বাইরে — এই মুহূর্তে বন্ধ করার কিছু নেই। ` +
      `নামাজ পড়ে "✅ পড়েছি" জানাবেন। 🤲`,
  })
}

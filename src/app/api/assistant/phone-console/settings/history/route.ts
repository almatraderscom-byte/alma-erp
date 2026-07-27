/**
 * GET  /api/assistant/phone-console/settings/history — who changed what, when, from what
 * POST same — put one change back
 *
 * Roadmap §3.4: every change is audited and reversible. A phone system that silently changed
 * under you is exactly how a whole day disappears, and "I think I changed something on
 * Tuesday" is not a state anyone can debug from.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { revertSetting, settingsHistory } from '@/agent/lib/phone-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response
  return NextResponse.json({ ok: true, history: await settingsHistory(60) })
}

export async function POST(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as { id?: string }
  const id = String(body.id ?? '').trim()
  if (!id) return NextResponse.json({ ok: false, error: 'কোন পরিবর্তন ফেরাবেন সেটা বলা হয়নি।' }, { status: 400 })

  const result = await revertSetting(id, gate.actor)
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true, value: result.value })
}

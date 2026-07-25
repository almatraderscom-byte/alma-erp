/**
 * GET  /api/assistant/phone-console/settings/hold — what the hold audio is right now
 * POST same — upload a recording and make it live
 *
 * The one config WRITE in step 2 that reaches the VPS, and it goes through the gateway's
 * control-plane endpoint rather than touching Asterisk from here. Roadmap §3.1: screens never
 * write config directly — they call something that validates, backs up, writes, reloads the
 * right module, verifies, and rolls back on failure. This route is the thin half of that; the
 * verifying half lives in the gateway, on the box, where it can actually check.
 *
 * Today this takes SSH, ffmpeg by hand, and a module unload/load that a plain reload silently
 * refuses to do (trap #16). The gateway also refuses while a call is up, because unloading
 * music-on-hold cuts the audio out from under whoever is listening to it.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { readSetting } from '@/agent/lib/phone-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// ffmpeg runs twice on the VPS and Asterisk is unloaded and loaded; 30 s is not enough.
export const maxDuration = 120

const MAX_BYTES = 8 * 1024 * 1024

function gateway(): { base: string; token: string } | null {
  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  return base && token ? { base, token } : null
}

export async function GET() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const gw = gateway()
  if (!gw) return NextResponse.json({ ok: true, hold: { configured: false, liveClass: null, files: [], busy: false, error: 'গেটওয়ের ঠিকানা সেট করা নেই।' } })

  try {
    const res = await fetch(`${gw.base}/api/v1/moh`, {
      headers: { Authorization: `Bearer ${gw.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json()) as Record<string, unknown>
    if (!res.ok) return NextResponse.json({ ok: true, hold: { configured: false, liveClass: null, files: [], busy: false, error: String(body.error ?? `HTTP ${res.status}`) } })
    return NextResponse.json({ ok: true, hold: body })
  } catch (err) {
    return NextResponse.json({
      ok: true,
      hold: { configured: false, liveClass: null, files: [], busy: false, error: err instanceof Error ? err.message : String(err) },
    })
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const gw = gateway()
  if (!gw) return NextResponse.json({ ok: false, error: 'গেটওয়ের ঠিকানা সেট করা নেই — VPS-এ পাঠানো যাবে না।' }, { status: 503 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: 'কোনো অডিও ফাইল পাওয়া যায়নি।' }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ ok: false, error: 'ফাইলটা খালি।' }, { status: 400 })
  if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: 'ফাইলটা ৮ MB-র বেশি — ছোট রেকর্ডিং দিন।' }, { status: 400 })

  // Whatever class the settings screen currently names, so the upload and the setting can
  // never drift apart into "the file is there but nothing plays it".
  const cls = (await readSetting('phone_moh_class')) || 'alma-hold'

  try {
    const res = await fetch(`${gw.base}/api/v1/moh`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gw.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Moh-Class': cls,
      },
      body: Buffer.from(await file.arrayBuffer()),
      signal: AbortSignal.timeout(110_000),
    })
    const body = (await res.json()) as { ok?: boolean; error?: string; steps?: unknown; liveClass?: string }
    if (!res.ok || body.ok === false) {
      return NextResponse.json({ ok: false, error: body.error ?? `HTTP ${res.status}`, steps: body.steps ?? [] }, { status: 400 })
    }
    return NextResponse.json({ ok: true, steps: body.steps ?? [], liveClass: body.liveClass ?? cls })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}

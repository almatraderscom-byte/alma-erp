/**
 * GET   /api/assistant/phone-console/extensions — who has a phone, is it connected, on a call
 * PATCH same — change one extension's policy (dial-out, DND, forward-to-mobile, disable)
 * POST  same — rotate the password, or remove the extension entirely
 *
 * Owner-only. Console step 3.
 *
 * THE SECRET NEVER COMES BACK. Not on create, not on rotate, not ever — the gateway does not
 * return it and this route could not forward it if it wanted to. A staff member's browser
 * fetches its own credential when they open the phone page, which is the only place it is
 * needed; "reveal password" is a feature of the old panel we deliberately did not copy. A
 * password that is never displayed cannot be screenshotted, pasted into a chat, or left on a
 * desk, and losing the ERP database therefore still does not leak the phone system.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { PHONE_SETTING_AUDIT } from '@/agent/lib/phone-settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

type GatewayStaff = {
  staffId: string
  ext: string
  name: string
  disabled: boolean
  dialOut: 'full' | 'mobile' | 'internal'
  dnd: boolean
  forwardTo: string
  registered: boolean
  onCall: { state: string | null; with: string | null; since: string | null } | null
}

function gateway(): { base: string; token: string } | null {
  const base = (process.env.SIP_GATEWAY_BASE ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  return base && token ? { base, token } : null
}

async function callGateway(path: string, init?: RequestInit) {
  const gw = gateway()
  if (!gw) throw new Error('গেটওয়ের ঠিকানা সেট করা নেই।')
  const res = await fetch(`${gw.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || body.ok === false) throw new Error(String(body.error ?? `HTTP ${res.status}`))
  return body
}

export async function GET() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  let staff: GatewayStaff[] = []
  let error: string | null = null
  try {
    const body = await callGateway('/api/v1/webrtc/list')
    staff = (body.staff as GatewayStaff[]) ?? []
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  // Names come from OUR database; the gateway only knows a staff id. And the list of people
  // WITHOUT a phone matters as much as the list with one — "nobody set Karim up" is
  // invisible on a screen that only shows the extensions that exist.
  //
  // Call COUNTS are deliberately not here. A staff member's own calls never touch the
  // gateway — the browser registers straight to Asterisk and the dialplan dials out — so
  // `agent_voice_calls` has no row for them and inventing a count from the AI's calls would
  // be worse than showing none. Per-extension history comes from Asterisk's own call log,
  // on its own endpoint, where it can say plainly when that log is not available.
  const users = (await db.user.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  }).catch(() => [])) as Array<{ id: string; name: string; role: string }>

  const byId = new Map(users.map((u) => [u.id, u]))
  const provisioned = new Set(staff.map((s) => s.staffId))

  return NextResponse.json({
    ok: true,
    error,
    extensions: staff.map((s) => ({
      ...s,
      name: byId.get(s.staffId)?.name || s.name || '',
      role: byId.get(s.staffId)?.role ?? null,
    })),
    withoutPhone: users.filter((u) => !provisioned.has(u.id)).map((u) => ({ id: u.id, name: u.name, role: u.role })),
  })
}

export async function PATCH(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as {
    staffId?: string
    dialOut?: string
    dnd?: boolean
    disabled?: boolean
    forwardTo?: string
    label?: string
  }
  const staffId = String(body.staffId ?? '').trim()
  if (!staffId) return NextResponse.json({ ok: false, error: 'কোন এক্সটেনশন সেটা বলা হয়নি।' }, { status: 400 })

  try {
    await callGateway('/api/v1/webrtc/policy', {
      method: 'POST',
      body: JSON.stringify({
        staffId,
        ...(body.dialOut ? { dialOut: body.dialOut } : {}),
        ...(typeof body.dnd === 'boolean' ? { dnd: body.dnd } : {}),
        ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
        ...(typeof body.forwardTo === 'string' ? { forwardTo: body.forwardTo } : {}),
      }),
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }

  await audit(gate.actor, staffId, body.label ?? staffId, describe(body))
  return NextResponse.json({ ok: true })
}

export async function POST(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as { staffId?: string; action?: string; label?: string }
  const staffId = String(body.staffId ?? '').trim()
  const action = body.action === 'remove' ? 'remove' : body.action === 'rotate' ? 'rotate' : null
  if (!staffId || !action) return NextResponse.json({ ok: false, error: 'কী করতে হবে বোঝা গেল না।' }, { status: 400 })

  try {
    await callGateway(`/api/v1/webrtc/${action}`, { method: 'POST', body: JSON.stringify({ staffId }) })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }

  await audit(gate.actor, staffId, body.label ?? staffId,
    action === 'rotate' ? 'পাসওয়ার্ড বদলানো হয়েছে' : 'এক্সটেনশন মুছে ফেলা হয়েছে')
  return NextResponse.json({ ok: true })
}

function describe(b: { dialOut?: string; dnd?: boolean; disabled?: boolean; forwardTo?: string }): string {
  const bits: string[] = []
  if (b.dialOut) bits.push(`বাইরে কল: ${b.dialOut === 'full' ? 'সব দেশি নম্বর' : b.dialOut === 'mobile' ? 'শুধু মোবাইল' : 'শুধু ভেতরে'}`)
  if (typeof b.dnd === 'boolean') bits.push(b.dnd ? 'বিরক্ত করবেন না: চালু' : 'বিরক্ত করবেন না: বন্ধ')
  if (typeof b.disabled === 'boolean') bits.push(b.disabled ? 'ফোন বন্ধ' : 'ফোন চালু')
  if (typeof b.forwardTo === 'string') bits.push(b.forwardTo ? `না ধরলে ${b.forwardTo}-এ` : 'মোবাইলে পাঠানো বন্ধ')
  return bits.join(' · ') || 'পরিবর্তন'
}

/** Same log as the settings, so one history screen answers "what changed on the phone". */
async function audit(actor: string, staffId: string, label: string, to: string): Promise<void> {
  try {
    await db.agentAuditLog.create({
      data: {
        actionType: PHONE_SETTING_AUDIT,
        resourceId: `extension:${staffId}`,
        actor,
        payload: { key: `extension:${staffId}`, label: `এক্সটেনশন — ${label}`, from: '', to, scope: 'gateway' },
      },
    })
  } catch (err) {
    console.error('[phone-extensions] audit write failed', err)
  }
}

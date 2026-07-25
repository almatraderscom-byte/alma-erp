/**
 * POST /api/assistant/voice-call/sip-confirm — the result of a keypress confirmation on a
 * one-way (message) call placed over our self-hosted SIP gateway.
 *
 * WHY: a message call that just plays audio proves nothing — the phone may have been answered
 * by a pocket, or the person may not have listened. With confirmation the receiver presses a
 * key after hearing the message (1 = confirmed, 2 = declined by convention), the gateway waits
 * for it, and posts the answer here. That turns "we called them" into "they acknowledged",
 * which is what the owner actually needs for staff instructions and follow-ups.
 *
 * The gateway posts: { call_id, ref, digit, outcome, answeredAt }.
 * outcome ∈ confirmed | declined | no_response | other.
 *
 * Auth: Bearer AGENT_INTERNAL_TOKEN (the gateway runs on the VPS, not in a browser).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 20

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function bearerOk(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!expected || !got) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(got, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

const BANGLA: Record<string, string> = {
  confirmed: 'নিশ্চিত করেছেন (১ চেপেছেন)',
  declined: 'পারবেন না / পরে জানাবেন (২ চেপেছেন)',
  no_response: 'কোনো সাড়া দেননি (কিছু চাপেননি)',
  other: 'অন্য একটি বোতাম চেপেছেন',
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!bearerOk(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    call_id?: string; ref?: string | null; digit?: string | null; outcome?: string
  }
  const callSid = String(body.call_id ?? '').trim()
  const outcome = String(body.outcome ?? 'other')
  const digit = body.digit ?? null
  if (!callSid) return NextResponse.json({ ok: false, error: 'missing call_id' }, { status: 400 })

  const note = BANGLA[outcome] ?? BANGLA.other
  const summary = `এক-মুখী কল: প্রাপক ${note}।`

  // Attach to the call row when one exists (agent-placed calls), else record the outcome on
  // its own so the confirmation is never lost — worker-placed message calls have no row.
  let recordId: string | null = null
  try {
    const existing = await db.agentVoiceCall.findFirst({ where: { callSid }, select: { id: true } })
    if (existing) {
      await db.agentVoiceCall.update({
        where: { id: existing.id },
        data: {
          status: outcome === 'confirmed' ? 'completed' : outcome === 'no_response' ? 'no_answer' : 'completed',
          providerStatus: `confirm:${outcome}`,
          summary,
          endedAt: new Date(),
          reportReceivedAt: new Date(),
        },
      })
      recordId = existing.id
    } else {
      const created = await db.agentVoiceCall.create({
        data: {
          toNumber: String(body.ref ?? 'unknown'),
          recipientName: body.ref ? String(body.ref) : null,
          purpose: 'one_way_confirmation',
          firstMessage: '',
          status: outcome === 'no_response' ? 'no_answer' : 'completed',
          provider: 'sip',
          providerStatus: `confirm:${outcome}`,
          callSid,
          summary,
          endedAt: new Date(),
          reportReceivedAt: new Date(),
        },
      })
      recordId = created.id
    }
  } catch (err) {
    console.warn('[sip-confirm] persist failed:', err instanceof Error ? err.message : String(err))
  }

  // Tell the owner. A confirmation is only useful if it reaches him — but never as a voice
  // call (a phone call about a phone call), so this stays a silent tier-2 alert.
  const appUrl = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  const token = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (appUrl && token) {
    void fetch(`${appUrl}/api/assistant/internal/urgent-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tier: 2,
        title: 'এক-মুখী কলের নিশ্চিতকরণ',
        message: `${body.ref ? `${body.ref} — ` : ''}${note}.`,
        voice: false,
        category: 'one_way_call_confirmation',
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, callRecordId: recordId, outcome, digit })
}

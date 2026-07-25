/**
 * GET /api/assistant/phone-console/routing — the DID table + the DIDs we have actually seen
 * PUT same — replace the table
 *
 * Owner-only. The whole table is written at once (unlike the settings screen's one-field
 * saves) because the rows are one another's context: which line is the boss line only means
 * something relative to the others.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireConsoleOwner } from '@/agent/lib/phone-console-guard'
import { PHONE_SETTING_AUDIT } from '@/agent/lib/phone-settings'
import { OUR_DID, readDidRoutes, seenDids, writeDidRoutes, type DidRoute } from '@/agent/lib/phone-routing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET() {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const [dids, seen] = await Promise.all([readDidRoutes(), seenDids()])
  return NextResponse.json({ ok: true, dids, seenDids: seen, ourDid: OUR_DID })
}

export async function PUT(req: NextRequest) {
  const gate = await requireConsoleOwner()
  if (!gate.ok) return gate.response

  const body = (await req.json().catch(() => ({}))) as { dids?: DidRoute[] }
  const rows = Array.isArray(body.dids) ? body.dids : null
  if (!rows) return NextResponse.json({ ok: false, error: 'তালিকাটা পাওয়া যায়নি।' }, { status: 400 })
  if (rows.length > 40) return NextResponse.json({ ok: false, error: 'এতগুলো লাইন হওয়ার কথা নয়।' }, { status: 400 })

  // A DID with no digits matches nothing and would look like a working rule, which is worse
  // than an error — routing mistakes are invisible until a customer hits them.
  for (const r of rows) {
    const did = String(r.did ?? '').replace(/[^\d+]/g, '')
    if (!did) return NextResponse.json({ ok: false, error: 'প্রতিটা সারিতে DID নম্বর দিতে হবে।' }, { status: 400 })
    if (did.replace(/\D/g, '').length < 6) {
      return NextResponse.json({ ok: false, error: `“${r.did}” নম্বরটা DID হিসেবে ছোট মনে হচ্ছে।` }, { status: 400 })
    }
  }
  const seenTails = new Set<string>()
  for (const r of rows) {
    const t = String(r.did).replace(/\D/g, '').slice(-9)
    if (seenTails.has(t)) return NextResponse.json({ ok: false, error: `“${r.did}” দুইবার আছে।` }, { status: 400 })
    seenTails.add(t)
  }

  const before = await readDidRoutes()
  try {
    await writeDidRoutes(rows)
  } catch (err) {
    return NextResponse.json({ ok: false, error: `সেভ করা যায়নি: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 })
  }

  // Audited in the same log as the settings, so one history screen answers "what changed".
  try {
    await db.agentAuditLog.create({
      data: {
        actionType: PHONE_SETTING_AUDIT,
        resourceId: 'phone_did_map',
        actor: gate.actor,
        payload: {
          key: 'phone_did_map',
          label: 'ইনবাউন্ড রাউটিং তালিকা',
          from: before.map((r) => `${r.did}=${r.line}`).join(', '),
          to: rows.map((r) => `${r.did}=${r.line}`).join(', '),
          scope: 'app',
        },
      },
    })
  } catch (err) {
    console.error('[phone-routing] audit write failed', err)
  }

  return NextResponse.json({ ok: true, dids: await readDidRoutes() })
}

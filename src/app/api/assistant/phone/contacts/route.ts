/**
 * /api/assistant/phone/contacts — the shared business phonebook (owner ask 2026-09-01).
 *
 * Like a handset's contacts, but ONE book the whole team shares: a customer saved once
 * is named for everyone, on every ring surface — the CallKit lock-screen ring, the
 * in-call screen-pop and the recents list all resolve names through this table first,
 * before falling back to the ERP customer record.
 *
 * GET            → full list (small by nature; the team saves people, not spam).
 * POST {phone,name,note?} → upsert by normalized number.
 * DELETE {phone} → remove.
 *
 * Any staff member may read and save (naming callers IS the job of whoever answers);
 * VIEWER stays read-only. Numbers are stored as normalized BD-local digits.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { normalizeAlmaRole } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { normalizePhone } from '@/agent/lib/phone-contacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

 
const db = prisma as any

async function requireStaff(write: boolean) {
  const session = await getServerSession(authOptions)
  const user = session?.user as { id?: string; role?: string } | undefined
  if (!user?.id) return { error: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) }
  if (write && normalizeAlmaRole(user.role) === 'VIEWER') {
    return { error: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }) }
  }
  return { userId: user.id }
}

export async function GET() {
  const auth = await requireStaff(false)
  if ('error' in auth) return auth.error
  try {
    const rows = (await db.phoneContact.findMany({
      orderBy: { name: 'asc' },
      select: { phone: true, name: true, note: true },
    })) as Array<{ phone: string; name: string; note: string | null }>
    return NextResponse.json({ ok: true, contacts: rows })
  } catch (err) {
    return NextResponse.json({ ok: true, contacts: [], error: err instanceof Error ? err.message : String(err) })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(true)
  if ('error' in auth) return auth.error
  const body = (await req.json().catch(() => ({}))) as { phone?: string; name?: string; note?: string }
  const phone = normalizePhone(body.phone ?? '')
  const name = String(body.name ?? '').trim().slice(0, 80)
  if (phone.length < 3 || !name) {
    return NextResponse.json({ ok: false, error: 'need phone and name' }, { status: 400 })
  }
  try {
    await db.phoneContact.upsert({
      where: { phone },
      create: { phone, name, note: body.note?.slice(0, 200) ?? null, createdById: auth.userId },
      update: { name, note: body.note?.slice(0, 200) ?? null },
    })
    return NextResponse.json({ ok: true, phone, name })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireStaff(true)
  if ('error' in auth) return auth.error
  const body = (await req.json().catch(() => ({}))) as { phone?: string }
  const phone = normalizePhone(body.phone ?? '')
  if (!phone) return NextResponse.json({ ok: false, error: 'need phone' }, { status: 400 })
  try {
    await db.phoneContact.deleteMany({ where: { phone } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getJwt } from '@/lib/api-guards'
import { isSystemOwner } from '@/lib/roles'
import { roundMoney } from '@/lib/money'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'

export const revalidate = 0
export const runtime = 'nodejs'

/**
 * Owner personal পাওনা-দেনা khata (receivable/payable per person/organisation).
 * SUPER_ADMIN only — these are the owner's private ledgers, not staff money.
 *
 * GET  ?party_id=…  → one party + its serial txns (oldest→newest, running balance client-side)
 * GET               → all parties with computed net / txn count / last txn date
 * POST {op:'create_party'|'add_txn'|'edit_txn'|'delete_txn', …}
 *
 * Direction semantics: OUT = টাকা দিলাম (they owe more), IN = টাকা নিলাম/পেলাম.
 * Net = Σ(OUT) − Σ(IN); net > 0 owner receives (পাওনা), net < 0 owner owes (দেনা).
 */

type TxnShape = {
  id: string
  direction: 'OUT' | 'IN'
  amount: number
  reason: string
  txnDate: string
  createdAt: string
  edited: boolean
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function parseTxnDate(raw: unknown): Date | null {
  const s = String(raw || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function txnShape(t: {
  id: string
  direction: 'OUT' | 'IN'
  amount: Prisma.Decimal
  reason: string
  txnDate: Date
  createdAt: Date
  editHistory: Prisma.JsonValue
}): TxnShape {
  return {
    id: t.id,
    direction: t.direction,
    amount: roundMoney(Number(t.amount)),
    reason: t.reason,
    txnDate: toYmd(t.txnDate),
    createdAt: t.createdAt.toISOString(),
    edited: Array.isArray(t.editHistory) && t.editHistory.length > 0,
  }
}

async function requireOwner(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return { error: apiFailure('unauthorized', 'Login required.', { status: 401 }) }
  if (!isSystemOwner(token.role as string)) {
    return { error: apiFailure('forbidden', 'শুধু মালিক (Super Admin) এই খাতা দেখতে পারেন।', { status: 403 }) }
  }
  return { userId: token.sub }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireOwner(req)
    if ('error' in auth) return auth.error
    const partyId = new URL(req.url).searchParams.get('party_id')

    if (partyId) {
      const party = await prisma.personalLedgerParty.findFirst({
        where: { id: partyId, ownerUserId: auth.userId, archivedAt: null },
        include: {
          txns: {
            where: { deletedAt: null },
            orderBy: [{ txnDate: 'asc' }, { createdAt: 'asc' }],
          },
        },
      })
      if (!party) return apiFailure('not_found', 'খাতাটি পাওয়া যায়নি।', { status: 404 })
      const txns = party.txns.map(txnShape)
      const net = roundMoney(txns.reduce((s, t) => s + (t.direction === 'OUT' ? t.amount : -t.amount), 0))
      return NextResponse.json(
        { ok: true, party: { id: party.id, name: party.name, phone: party.phone, note: party.note, net, txns } },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }

    const parties = await prisma.personalLedgerParty.findMany({
      where: { ownerUserId: auth.userId, archivedAt: null },
      include: {
        txns: {
          where: { deletedAt: null },
          select: { direction: true, amount: true, txnDate: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    const rows = parties.map((p) => {
      const net = roundMoney(
        p.txns.reduce((s, t) => s + (t.direction === 'OUT' ? Number(t.amount) : -Number(t.amount)), 0),
      )
      const lastTxnDate = p.txns.reduce<string | null>((m, t) => {
        const d = toYmd(t.txnDate)
        return !m || d > m ? d : m
      }, null)
      return { id: p.id, name: p.name, phone: p.phone, net, txnCount: p.txns.length, lastTxnDate }
    })
    rows.sort((a, b) => String(b.lastTxnDate || '').localeCompare(String(a.lastTxnDate || '')))
    const totalReceivable = roundMoney(rows.reduce((s, r) => s + (r.net > 0 ? r.net : 0), 0))
    const totalPayable = roundMoney(rows.reduce((s, r) => s + (r.net < 0 ? -r.net : 0), 0))
    return NextResponse.json(
      { ok: true, parties: rows, totalReceivable, totalPayable, net: roundMoney(totalReceivable - totalPayable) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  } catch (e) {
    logEvent('error', 'personal_ledger.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'খাতা লোড করা যায়নি।', { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireOwner(req)
    if ('error' in auth) return auth.error
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const op = String(body.op || '')

    if (op === 'create_party') {
      const name = String(body.name || '').trim().slice(0, 120)
      if (!name) return apiFailure('bad_name', 'নাম দিন।', { status: 400 })
      const amount = roundMoney(Number(body.amount || 0))
      const direction = body.direction === 'IN' ? 'IN' : 'OUT'
      const txnDate = parseTxnDate(body.txn_date) || new Date()
      const reason = String(body.reason || '').trim().slice(0, 300)
      if (!(amount > 0) || !reason) {
        return apiFailure('bad_txn', 'প্রথম লেনদেনের সঠিক পরিমাণ ও কারণ দিন।', { status: 400 })
      }
      const party = await prisma.personalLedgerParty.create({
        data: {
          ownerUserId: auth.userId,
          name,
          phone: body.phone ? String(body.phone).slice(0, 40) : null,
          txns: { create: { direction, amount, reason, txnDate } },
        },
        select: { id: true },
      })
      logEvent('info', 'personal_ledger.party_created', { partyId: party.id })
      return NextResponse.json({ ok: true, partyId: party.id, message: `${name} — খাতা খোলা হয়েছে।` })
    }

    if (op === 'add_txn') {
      const partyId = String(body.party_id || '')
      const party = await prisma.personalLedgerParty.findFirst({
        where: { id: partyId, ownerUserId: auth.userId, archivedAt: null },
        select: { id: true, name: true },
      })
      if (!party) return apiFailure('not_found', 'খাতাটি পাওয়া যায়নি।', { status: 404 })
      const amount = roundMoney(Number(body.amount || 0))
      const direction = body.direction === 'IN' ? 'IN' : 'OUT'
      const txnDate = parseTxnDate(body.txn_date) || new Date()
      const reason = String(body.reason || '').trim().slice(0, 300)
      if (!(amount > 0) || !reason) {
        return apiFailure('bad_txn', 'সঠিক পরিমাণ ও কারণ দিন।', { status: 400 })
      }
      const txn = await prisma.personalLedgerTxn.create({
        data: { partyId: party.id, direction, amount, reason, txnDate },
        select: { id: true },
      })
      return NextResponse.json({ ok: true, txnId: txn.id, message: 'লেনদেন যোগ হয়েছে।' })
    }

    if (op === 'edit_txn' || op === 'delete_txn') {
      const txnId = String(body.txn_id || '')
      const existing = await prisma.personalLedgerTxn.findFirst({
        where: { id: txnId, deletedAt: null, party: { ownerUserId: auth.userId } },
      })
      if (!existing) return apiFailure('not_found', 'লেনদেনটি পাওয়া যায়নি।', { status: 404 })

      if (op === 'delete_txn') {
        await prisma.personalLedgerTxn.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        })
        return NextResponse.json({ ok: true, message: 'লেনদেন মুছে ফেলা হয়েছে।' })
      }

      const amount = body.amount !== undefined ? roundMoney(Number(body.amount)) : Number(existing.amount)
      const direction = body.direction === 'IN' ? 'IN' : body.direction === 'OUT' ? 'OUT' : existing.direction
      const reason = body.reason !== undefined ? String(body.reason).trim().slice(0, 300) : existing.reason
      const txnDate = body.txn_date !== undefined ? parseTxnDate(body.txn_date) : existing.txnDate
      if (!(amount > 0) || !reason || !txnDate) {
        return apiFailure('bad_txn', 'সঠিক পরিমাণ, কারণ ও তারিখ দিন।', { status: 400 })
      }
      const historyEntry = {
        at: new Date().toISOString(),
        byUserId: auth.userId,
        prev: {
          direction: existing.direction,
          amount: roundMoney(Number(existing.amount)),
          reason: existing.reason,
          txnDate: toYmd(existing.txnDate),
        },
      }
      const prevHistory = Array.isArray(existing.editHistory) ? (existing.editHistory as Prisma.JsonArray) : []
      await prisma.personalLedgerTxn.update({
        where: { id: existing.id },
        data: {
          direction,
          amount,
          reason,
          txnDate,
          editHistory: [...prevHistory, historyEntry] as Prisma.InputJsonValue,
        },
      })
      return NextResponse.json({ ok: true, message: 'লেনদেন অ্যাডজাস্ট হয়েছে।' })
    }

    return apiFailure('bad_op', 'অজানা অপারেশন।', { status: 400 })
  } catch (e) {
    logEvent('error', 'personal_ledger.write_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'সংরক্ষণ করা যায়নি।', { status: 500 })
  }
}

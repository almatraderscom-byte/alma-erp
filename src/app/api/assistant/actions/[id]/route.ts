import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  applyFinanceFieldEdit,
  financeEditFieldsForType,
  getEntryCount,
  isFinanceConfirmType,
  removeBatchEntry,
  rebuildFinanceSummary,
} from '@/agent/lib/finance-pending'
import {
  formatExpenseLineSummary,
  formatLedgerLineSummary,
} from '@/agent/lib/finance-shared'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = _req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req: _req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const action = await (prisma as any).agentPendingAction.findUnique({ where: { id: params.id } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })

  return Response.json({
    id: action.id,
    type: action.type,
    summary: action.summary,
    status: action.status,
    isFinance: isFinanceConfirmType(action.type),
    entryCount: getEntryCount(action),
    editFields: financeEditFieldsForType(action.type),
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { removeEntryIndex?: number; field?: string; value?: unknown; convertToSingle?: boolean }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const action = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!action) return Response.json({ error: 'not_found' }, { status: 404 })
  if (action.status !== 'pending') {
    return Response.json({ error: 'already_resolved', status: action.status }, { status: 409 })
  }
  if (!isFinanceConfirmType(action.type)) {
    return Response.json({ error: 'not_finance_action' }, { status: 400 })
  }

  let newType = action.type as string
  let newPayload = action.payload as Record<string, unknown>
  let newSummary = action.summary as string

  if (body.removeEntryIndex !== undefined) {
    const result = removeBatchEntry(action, Number(body.removeEntryIndex))
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 })
    newPayload = result.payload
    newSummary = result.summary

    const entries = newPayload.entries as unknown[] | undefined
    if (!entries && newPayload.personName) {
      newType = 'log_ledger_entry'
    } else if (!entries && newPayload.amount && newPayload.note) {
      newType = 'log_expense'
    } else if (Array.isArray(entries) && entries.length === 1) {
      const e = entries[0] as Record<string, unknown>
      if (action.type.startsWith('log_ledger')) {
        newType = 'log_ledger_entry'
        newPayload = {
          personName: e.personName,
          direction: e.direction,
          amount: e.amount,
          currency: e.currency || 'BDT',
          note: e.note ?? null,
          occurredAt: e.occurredAt || new Date().toISOString(),
        }
        newSummary = formatLedgerLineSummary(
          String(newPayload.personName),
          String(newPayload.direction),
          Number(newPayload.amount),
          String(newPayload.currency),
          newPayload.note as string | null,
        )
      } else {
        newType = 'log_expense'
        newPayload = {
          amount: e.amount,
          currency: e.currency || 'BDT',
          category: e.category ?? null,
          note: e.note ?? 'খরচ',
          occurredAt: e.occurredAt || new Date().toISOString(),
        }
        newSummary = formatExpenseLineSummary(
          Number(newPayload.amount),
          String(newPayload.currency),
          String(newPayload.note),
          newPayload.category as string | null,
        )
      }
    }
  } else if (body.field && body.value !== undefined) {
    const result = applyFinanceFieldEdit(action, String(body.field), body.value)
    if ('error' in result) return Response.json({ error: result.error }, { status: 400 })
    newPayload = result.payload
    newSummary = result.summary
  } else {
    return Response.json({ error: 'nothing_to_patch' }, { status: 400 })
  }

  const updated = await db.agentPendingAction.update({
    where: { id: params.id },
    data: { type: newType, payload: newPayload, summary: newSummary },
  })

  return Response.json({
    success: true,
    id: updated.id,
    type: updated.type,
    summary: updated.summary,
    entryCount: getEntryCount(updated),
    isFinance: true,
    isBatch: updated.type === 'log_ledger_entries_batch' || updated.type === 'log_expenses_batch',
  })
}

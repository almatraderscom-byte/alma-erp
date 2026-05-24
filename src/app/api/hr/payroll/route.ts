import { NextRequest, NextResponse } from 'next/server'
import type { EmployeeLedgerEntryType } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { createCompensationLedgerEntry, isDebitCompensationType } from '@/lib/payroll-compensation'
import { logEvent } from '@/lib/logger'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    const data = await serverGet('hr_payroll', p, 0)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const result = await serverPost('hr_payroll_add', await mergeActorPayload(req, body as Record<string, unknown>))
    const wallet = await mirrorLegacyPayrollToWallet(req, body as Record<string, unknown>, result as Record<string, unknown>)
    return NextResponse.json({ ...(result as Record<string, unknown>), wallet })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

function walletTypeFromLegacy(txType: unknown): EmployeeLedgerEntryType | null {
  const key = String(txType || '').trim().toLowerCase()
  if (key === 'deposit' || key === 'salary' || key === 'salary_accrual') return 'SALARY_ACCRUAL'
  if (key === 'salary_payment' || key === 'withdrawal' || key === 'payout') return 'WITHDRAWAL'
  if (key === 'advance') return 'ADVANCE'
  if (key === 'adjustment') return 'ADJUSTMENT'
  return null
}

async function mirrorLegacyPayrollToWallet(
  req: NextRequest,
  body: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  if (!result?.ok) return { ok: false, skipped: 'legacy_write_failed' }
  const type = walletTypeFromLegacy(body.tx_type)
  if (!type) return { ok: true, skipped: 'legacy_type_not_wallet_mirrored' }

  const businessId = String(body.business_id || 'ALMA_LIFESTYLE')
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx) return { ok: false, skipped: 'wallet_context_denied' }
  if (!ctx.isAdmin) return { ok: false, skipped: 'not_wallet_admin' }

  const employeeId = String(body.emp_id || '').trim()
  const amount = Number(body.amount || 0)
  if (!employeeId || !Number.isFinite(amount) || amount === 0) return { ok: false, skipped: 'missing_employee_or_amount' }

  const txKey = String(body.tx_type || '').trim().toLowerCase()
  if (txKey === 'salary_payment' && String(body.source || '') !== 'wallet_request') {
    logEvent('warn', 'payroll.salary_payment_manual_use', {
      employeeId,
      amount,
      businessId: ctx.businessIds[0],
      userId: ctx.userId,
      legacyTxId: String(result.tx_id || ''),
      note: String(body.note || '').slice(0, 200),
    })
  }

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId,
      businessId: ctx.businessIds[0],
      effectiveDate: body.date ? new Date(String(body.date)) : new Date(),
      periodYm: body.period_ym ? String(body.period_ym) : null,
      type,
      amount: isDebitCompensationType(type) ? Math.abs(amount) : amount,
      note: String(body.note || '').trim() || `Mirrored from legacy payroll ${String(result.tx_id || '')}`,
      createdById: ctx.userId,
      approvedById: ctx.userId,
      source: 'legacy_hr_payroll',
      sourceRef: `legacy_hr_payroll:${ctx.businessIds[0]}:${String(result.tx_id || crypto.randomUUID())}`,
    })
    return { ok: true, entryId: entry.id, employeeId, businessId: ctx.businessIds[0], type }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { ok: true, skipped: 'wallet_entry_already_mirrored' }
    }
    throw e
  }
}

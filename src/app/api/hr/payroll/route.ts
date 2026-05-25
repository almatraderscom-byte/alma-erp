import { NextRequest, NextResponse } from 'next/server'
import type { EmployeeLedgerEntryType } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { getWalletContext, resolveWalletScopeBusinessId } from '@/lib/payroll-wallet-access'
import { createCompensationLedgerEntry, isDebitCompensationType } from '@/lib/payroll-compensation'
import { logEvent } from '@/lib/logger'

type MirrorWalletResult = {
  ok: boolean
  skipped?: string
  entryId?: string
  employeeId?: string
  businessId?: string
  type?: string
}

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

function logMirrorSkip(
  reason: string,
  body: Record<string, unknown>,
  extra: {
    result?: Record<string, unknown>
    userId?: string
    role?: string
    businessId?: string
    employeeId?: string
    amount?: number
  } = {},
): MirrorWalletResult {
  logEvent('warn', 'payroll.legacy_mirror_skipped', {
    reason,
    employeeId: extra.employeeId ?? (String(body.emp_id || '').trim() || undefined),
    tx_type: body.tx_type,
    amount: extra.amount ?? Number(body.amount || 0),
    userId: extra.userId,
    role: extra.role,
    businessId: extra.businessId ?? (String(body.business_id || '').trim() || undefined),
    legacyTxId: extra.result ? String(extra.result.tx_id || '') : undefined,
  })
  const ok = reason === 'legacy_type_not_wallet_mirrored' || reason === 'wallet_entry_already_mirrored'
  return { ok, skipped: reason }
}

async function mirrorLegacyPayrollToWallet(
  req: NextRequest,
  body: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<MirrorWalletResult> {
  const requestedBusinessId = String(body.business_id || 'ALMA_LIFESTYLE').trim()
  const employeeId = String(body.emp_id || '').trim()
  const amount = Number(body.amount || 0)

  if (!result?.ok) {
    return logMirrorSkip('legacy_write_failed', body, { result, employeeId, amount, businessId: requestedBusinessId })
  }

  const type = walletTypeFromLegacy(body.tx_type)
  if (!type) {
    return logMirrorSkip('legacy_type_not_wallet_mirrored', body, { result, employeeId, amount, businessId: requestedBusinessId })
  }

  const ctx = await getWalletContext(req, requestedBusinessId)
  if ('error' in ctx) {
    return logMirrorSkip('wallet_context_denied', body, { result, employeeId, amount, businessId: requestedBusinessId })
  }

  if (!ctx.isAdmin) {
    return logMirrorSkip('not_wallet_admin', body, {
      result,
      employeeId,
      amount,
      businessId: requestedBusinessId,
      userId: ctx.userId,
      role: ctx.role,
    })
  }

  if (!employeeId || !Number.isFinite(amount) || amount === 0) {
    return logMirrorSkip('missing_employee_or_amount', body, {
      result,
      employeeId,
      amount,
      businessId: requestedBusinessId,
      userId: ctx.userId,
      role: ctx.role,
    })
  }

  const scopedBusinessId = resolveWalletScopeBusinessId(ctx.businessIds, requestedBusinessId)

  const txKey = String(body.tx_type || '').trim().toLowerCase()
  if (txKey === 'salary_payment' && String(body.source || '') !== 'wallet_request') {
    logEvent('warn', 'payroll.salary_payment_manual_use', {
      employeeId,
      amount,
      businessId: scopedBusinessId,
      userId: ctx.userId,
      legacyTxId: String(result.tx_id || ''),
      note: String(body.note || '').slice(0, 200),
    })
  }

  try {
    const entry = await createCompensationLedgerEntry({
      employeeId,
      businessId: scopedBusinessId,
      effectiveDate: body.date ? new Date(String(body.date)) : new Date(),
      periodYm: body.period_ym ? String(body.period_ym) : null,
      type,
      amount: isDebitCompensationType(type) ? Math.abs(amount) : amount,
      note: String(body.note || '').trim() || `Mirrored from legacy payroll ${String(result.tx_id || '')}`,
      createdById: ctx.userId,
      approvedById: ctx.userId,
      source: 'legacy_hr_payroll',
      sourceRef: `legacy_hr_payroll:${scopedBusinessId}:${String(result.tx_id || crypto.randomUUID())}`,
    })
    return { ok: true, entryId: entry.id, employeeId, businessId: scopedBusinessId, type }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return logMirrorSkip('wallet_entry_already_mirrored', body, {
        result,
        employeeId,
        amount,
        businessId: scopedBusinessId,
        userId: ctx.userId,
        role: ctx.role,
      })
    }
    throw e
  }
}

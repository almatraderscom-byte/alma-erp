import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'

/**
 * Office petty-cash fund (ALMA_LIFESTYLE only, per owner decision 2026-06-30).
 *
 * A single shared cash pool the owner tops up and admins draw office advances
 * from. The balance is DERIVED from an append-only ledger (OfficeFundEntry),
 * exactly like the staff wallet is derived from EmployeeLedgerEntry — never a
 * mutable running total. All amounts are whole taka (BDT) via roundMoney.
 *
 * This is intentionally separate from the per-staff wallet: office money handed
 * to a staffer is NOT that staffer's salary; it stays the company's money until
 * accounted for (see the office-advance reconciliation phase).
 */

export const OFFICE_FUND_BUSINESS_ID = 'ALMA_LIFESTYLE'

export type OfficeFundEntryType =
  | 'TOP_UP' // owner adds cash to the fund (money in)
  | 'RETURN_IN' // unspent office advance returned to the fund (money in)
  | 'ADVANCE_OUT' // money handed to an admin as an office advance (money out)
  | 'EXPENSE' // office advance reconciled as a real expense (money out)
  | 'ADJUSTMENT' // signed manual correction (admin only)

/** Entry types that increase the fund balance. */
const CREDIT_TYPES: ReadonlySet<string> = new Set(['TOP_UP', 'RETURN_IN'])
/** Entry types that decrease the fund balance. */
const DEBIT_TYPES: ReadonlySet<string> = new Set(['ADVANCE_OUT', 'EXPENSE'])

export interface OfficeFundLedgerRow {
  id: string
  type: string
  amount: number
  note: string | null
  refType: string | null
  refId: string | null
  createdByName: string | null
  createdAt: string
}

export interface OfficeFundSummary {
  businessId: string
  balance: number
  totalIn: number
  totalOut: number
  entryCount: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db(): any {
  // The Prisma client model is freshly generated; cast keeps this resilient to
  // client-generation timing in CI without weakening callers' types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (prisma as any).officeFundEntry
}

/** Signed contribution of one ledger row to the running balance (whole taka). */
function signedAmount(type: string, amount: number): number {
  const a = roundMoney(amount)
  if (CREDIT_TYPES.has(type)) return a
  if (DEBIT_TYPES.has(type)) return -a
  // ADJUSTMENT (or any future signed type) is stored signed already.
  return a
}

export async function computeOfficeFundSummary(
  businessId: string = OFFICE_FUND_BUSINESS_ID,
): Promise<OfficeFundSummary> {
  const rows: Array<{ type: string; amount: number }> = await db().findMany({
    where: { businessId, deletedAt: null },
    select: { type: true, amount: true },
  })
  let totalIn = 0
  let totalOut = 0
  for (const r of rows) {
    const signed = signedAmount(r.type, r.amount)
    if (signed >= 0) totalIn += signed
    else totalOut += -signed
  }
  return {
    businessId,
    balance: roundMoney(totalIn - totalOut),
    totalIn: roundMoney(totalIn),
    totalOut: roundMoney(totalOut),
    entryCount: rows.length,
  }
}

export async function computeOfficeFundBalance(
  businessId: string = OFFICE_FUND_BUSINESS_ID,
): Promise<number> {
  return (await computeOfficeFundSummary(businessId)).balance
}

export async function getOfficeFundLedger(
  businessId: string = OFFICE_FUND_BUSINESS_ID,
  limit = 50,
): Promise<OfficeFundLedgerRow[]> {
  const rows: Array<{
    id: string
    type: string
    amount: number
    note: string | null
    refType: string | null
    refId: string | null
    createdByName: string | null
    createdAt: Date
  }> = await db().findMany({
    where: { businessId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(200, limit)),
    select: {
      id: true,
      type: true,
      amount: true,
      note: true,
      refType: true,
      refId: true,
      createdByName: true,
      createdAt: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: roundMoney(r.amount),
    note: r.note,
    refType: r.refType,
    refId: r.refId,
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
  }))
}

export interface RecordFundEntryInput {
  businessId?: string
  type: OfficeFundEntryType
  amount: number
  note?: string | null
  refType?: string | null
  refId?: string | null
  createdById?: string | null
  createdByName?: string | null
}

/**
 * Append a ledger entry and return the new fund balance. Low-level — callers
 * (top-up, advance disbursement, reconciliation) decide the `type`.
 */
export async function recordFundEntry(
  input: RecordFundEntryInput,
): Promise<{ id: string; balance: number }> {
  const businessId = input.businessId ?? OFFICE_FUND_BUSINESS_ID
  const amount = roundMoney(input.amount)
  const created = await db().create({
    data: {
      businessId,
      type: input.type,
      amount,
      note: input.note ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      createdById: input.createdById ?? null,
      createdByName: input.createdByName ?? null,
    },
    select: { id: true },
  })
  const balance = await computeOfficeFundBalance(businessId)
  return { id: created.id, balance }
}

export interface TopUpInput {
  businessId?: string
  amount: number
  note?: string | null
  createdById?: string | null
  createdByName?: string | null
}

/** Owner adds cash to the office fund. Amount must be a positive whole taka. */
export async function topUpOfficeFund(
  input: TopUpInput,
): Promise<{ id: string; balance: number }> {
  const amount = roundMoney(input.amount)
  if (!(amount > 0)) {
    throw new Error('top_up_amount_must_be_positive')
  }
  return recordFundEntry({
    businessId: input.businessId,
    type: 'TOP_UP',
    amount,
    note: input.note ?? null,
    createdById: input.createdById ?? null,
    createdByName: input.createdByName ?? null,
  })
}

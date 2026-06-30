import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendFinanceAlert } from '@/lib/resend'
import { prisma } from '@/lib/prisma'
import { notifyRole } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { TRADING_BUSINESS_ID, numberFromDecimal } from '@/lib/trading'
import { getLifestyleFinance } from '@/lib/lifestyle/read'
import { persistExpenseFromPayload, enqueueExpenseApproval } from '@/lib/finance-expense'

export const revalidate = 0

const LIFESTYLE_BUSINESS_ID = 'ALMA_LIFESTYLE'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    if (p.business_id === TRADING_BUSINESS_ID) {
      return NextResponse.json(await tradingFinanceLedger(p), {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }
    if (!p.business_id || p.business_id === LIFESTYLE_BUSINESS_ID) {
      return NextResponse.json(await getLifestyleFinance(p), {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }
    return NextResponse.json(await serverGet('finance', p, 0), {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  catch (e) {
    logEvent('error', 'finance.read_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not load finance data.', { status: 500 })
  }
}

async function tradingFinanceLedger(params: Record<string, string>) {
  const { start, end } = financeDateRange(params)
  const [expenses, expenseGroups, cashAgg] = await Promise.all([
    prisma.tradingExpense.findMany({
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, expenseDate: { gte: start, lte: end } },
      orderBy: { expenseDate: 'desc' },
      take: 500,
      include: { tradingAccount: { select: { accountTitle: true } }, creator: { select: { name: true } } },
    }),
    prisma.tradingExpense.groupBy({
      by: ['expenseType'],
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null, expenseDate: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.tradingAccount.aggregate({
      where: { businessId: TRADING_BUSINESS_ID, deletedAt: null },
      _sum: { currentBalance: true },
    }),
  ])
  const ledgerRows = expenses.map(expense => ({
    exp_id: expense.id,
    date: expense.expenseDate.toISOString().slice(0, 10),
    month: expense.expenseDate.toISOString().slice(0, 7),
    category: expense.expenseType,
    business_id: TRADING_BUSINESS_ID,
    sub_cat: expense.tradingAccount.accountTitle,
    exp_type: 'Trading Account Expense',
    title: `${expense.tradingAccount.accountTitle} · ${expense.expenseType}`,
    desc: expense.notes || '',
    vendor: expense.tradingAccount.accountTitle,
    amount: numberFromDecimal(expense.amount),
    payment_method: 'Trading wallet',
    payment_status: 'Paid',
    receipt_ref: expense.attachmentUrl || '',
    notes: expense.notes || '',
  }))
  const byCategory = Object.fromEntries(expenseGroups.map(group => [group.expenseType, numberFromDecimal(group._sum.amount)]))
  const totalExpenses = ledgerRows.reduce((sum, row) => sum + row.amount, 0)
  return {
    total_expenses: totalExpenses,
    cash_balance: numberFromDecimal(cashAgg._sum.currentBalance),
    by_category: byCategory,
    by_type: byCategory,
    expenses: ledgerRows,
    recent_expenses: ledgerRows.slice(0, 10),
  }
}

function financeDateRange(params: Record<string, string>) {
  const start = params.startDate ? new Date(params.startDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  const end = params.endDate ? new Date(params.endDate) : new Date()
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

export async function POST(req: NextRequest) {
  try {
    const raw = (await req.json()) as Record<string, unknown>
    const payload = await mergeActorPayload(req, raw)
    const businessId = String(raw.business_id || LIFESTYLE_BUSINESS_ID)

    // Owner directive: only a Super Admin can add an expense directly. Anyone
    // else (admin or staff) routes the add through the approval center — it is
    // created only once the owner approves, and not at all if rejected.
    if (String(payload.actor_role || '') !== 'SUPER_ADMIN') {
      const approval = await enqueueExpenseApproval(payload)
      return NextResponse.json({
        ok: true,
        pending_approval: true,
        approval_id: approval.id,
        message: 'খরচটি অনুমোদনের জন্য পাঠানো হয়েছে। অনুমোদন হলে যোগ হবে।',
      })
    }

    const { result, expenseId } = await persistExpenseFromPayload(payload)
    const amount = Number(raw.amount || 0)
    const category = String(raw.category || 'Expense')
    void Promise.all([
      notifyRole({
        role: 'SUPER_ADMIN',
        businessId,
        type: 'EXPENSE_ADDED',
        priority: amount >= 10000 ? 'HIGH' : 'NORMAL',
        title: 'Expense added',
        message: `${category} · ৳${amount.toLocaleString('en-BD')}`,
        actionUrl: '/finance',
      }),
      sendFinanceAlert({
      businessId,
      subject: `Expense added · ৳${Number(raw.amount || 0).toLocaleString('en-BD')}`,
      title: 'Expense added',
      preview: `${String(raw.category || 'Expense')} · ৳${Number(raw.amount || 0).toLocaleString('en-BD')}`,
      text: `Expense added: ${String(raw.category || 'Expense')} for ৳${Number(raw.amount || 0).toLocaleString('en-BD')}.`,
      priority: 'NORMAL',
      actionUrl: '/finance',
      actionLabel: 'Open finance',
      dedupeKey: `expense-added:${expenseId || Date.now()}`,
      metadata: { result, raw },
      }),
    ]).catch(() => {})
    return NextResponse.json(result)
  }
  catch (e) {
    logEvent('error', 'finance.expense_failed', { error: (e as Error).message })
    return apiFailure('server_error', 'Could not save the expense.', { status: 500 })
  }
}

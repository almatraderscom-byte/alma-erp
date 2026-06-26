import { NextRequest, NextResponse } from 'next/server'
import { serverGet, serverPost } from '@/lib/server-api'
import { mergeActorPayload } from '@/lib/api-route-actor'
import { sendFinanceAlert } from '@/lib/resend'
import { prisma } from '@/lib/prisma'
import { notifyRole } from '@/lib/notifications'
import { logEvent } from '@/lib/logger'
import { apiFailure } from '@/lib/safe-api-response'
import { TRADING_BUSINESS_ID, numberFromDecimal } from '@/lib/trading'

export const revalidate = 0

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams)
  try {
    if (p.business_id === TRADING_BUSINESS_ID) {
      return NextResponse.json(await tradingFinanceLedger(p), {
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
    const result = await serverPost('add_expense', await mergeActorPayload(req, raw))
    const attachmentId = String(raw.receipt_attachment_id || '').trim()
    const expenseId = String((result as { expense_id?: string; exp_id?: string }).expense_id || (result as { exp_id?: string }).exp_id || '')
    if (attachmentId && expenseId) {
      await prisma.expenseAttachment.updateMany({
        where: { id: attachmentId, deletedAt: null },
        data: { expenseId },
      })
    }
    const businessId = String(raw.business_id || 'ALMA_LIFESTYLE')
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
      dedupeKey: `expense-added:${String((result as { expense_id?: string }).expense_id || Date.now())}`,
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

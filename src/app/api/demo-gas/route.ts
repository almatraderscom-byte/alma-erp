/**
 * demo-gas — a stand-in for the Google Apps Script backend, for the DEMO instance only.
 *
 * Orders, stock, customers and expenses moved to Postgres, but Employees, Payroll,
 * Finance, CDIT and Branding still read from the live Google Sheet through
 * `server-api.ts`. On a demo deployment that would serve REAL company data — real
 * staff names, real salaries — no matter how fake the demo database is. Pointing
 * `NEXT_PUBLIC_API_URL` at this route closes that hole.
 *
 * Answers are derived from the seeded demo database (see `scripts/demo-seed.mjs`)
 * rather than from a second pile of fixtures, so the Employees page agrees with
 * attendance, and Finance agrees with the expense ledger.
 *
 * Never reachable in production: `DEMO_MODE` must be `true` AND the caller must
 * present the deployment's own `API_SECRET`, exactly as the real GAS endpoint does.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { defaultBusinessBranding } from '@/lib/branding-defaults'
import type { BusinessId } from '@/lib/businesses'
import type {
  EmployeePayrollRoll,
  ERPFinanceExpense,
  ERPFinanceResponse,
  HREmployee,
} from '@/types/hr'

export const dynamic = 'force-dynamic'

const DEMO_EMAIL_SUFFIX = '@alma-erp.demo'

function isDemoDeployment() {
  return process.env.DEMO_MODE === 'true'
}

function ymd(d: Date | null | undefined) {
  return d ? d.toISOString().slice(0, 10) : ''
}

async function demoEmployees(businessId: string): Promise<HREmployee[]> {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_EMAIL_SUFFIX }, active: true },
    orderBy: { createdAt: 'asc' },
  })
  return users.map(u => ({
    emp_id: u.employeeIdGas || u.id,
    business_id: businessId,
    name: u.name,
    phone: u.phone || '',
    email: u.email || '',
    address: 'ঢাকা, বাংলাদেশ',
    role: u.role,
    joining_date: ymd(u.joiningDate),
    monthly_salary: Number(u.salaryHint || 0),
    status: 'Active',
    notes: '',
  }))
}

async function demoFinance(businessId: string): Promise<ERPFinanceResponse> {
  const rows = await prisma.lifestyleExpense.findMany({
    where: { businessId, deletedAt: null },
    orderBy: { expenseDate: 'desc' },
  })

  const expenses: ERPFinanceExpense[] = rows.map(r => ({
    exp_id: r.id,
    date: ymd(r.expenseDate),
    month: ymd(r.expenseDate).slice(0, 7),
    category: r.category,
    business_id: r.businessId,
    sub_cat: r.subCat || '',
    exp_type: r.expType || r.category,
    title: r.title || r.category,
    desc: r.description || '',
    vendor: r.vendor || '',
    amount: r.amount,
    payment_method: r.paymentMethod || '',
    payment_status: r.paymentStatus || '',
    receipt_ref: r.receiptRef || '',
  }))

  const byCategory: Record<string, number> = {}
  const byType: Record<string, number> = {}
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount
    byType[e.exp_type] = (byType[e.exp_type] || 0) + e.amount
  }
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0)

  const delivered = await prisma.lifestyleOrder.aggregate({
    where: { businessId, status: 'Delivered' },
    _sum: { sellPrice: true },
  })
  const revenue = delivered._sum.sellPrice || 0

  return {
    total_expenses: totalExpenses,
    cash_balance: revenue - totalExpenses,
    by_category: byCategory,
    by_type: byType,
    expenses,
    recent_expenses: expenses.slice(0, 20),
  }
}

/** Payroll is not seeded as transactions — the roll is derived so the page still balances. */
function payrollRoll(employees: HREmployee[]): EmployeePayrollRoll[] {
  return employees
    .filter(e => e.monthly_salary > 0)
    .map(e => ({
      emp_id: e.emp_id,
      name: e.name,
      monthly_salary: e.monthly_salary,
      advance_balance: 0,
      deposits: 0,
      salary_paid: e.monthly_salary,
      adjustments: 0,
      current_due: 0,
    }))
}

async function handleRoute(route: string, params: URLSearchParams) {
  const businessId = params.get('business_id') || 'ALMA_LIFESTYLE'

  switch (route) {
    case 'hr_employees': {
      const employees = await demoEmployees(businessId)
      return { employees, total: employees.length }
    }

    case 'finance':
    case 'financial_report':
      return demoFinance(businessId)

    case 'hr_dashboard': {
      const [employees, finance] = await Promise.all([
        demoEmployees(businessId),
        demoFinance(businessId),
      ])
      const totalSalary = employees.reduce((s, e) => s + e.monthly_salary, 0)
      const orders = await prisma.lifestyleOrder.aggregate({
        where: { businessId, status: 'Delivered' },
        _sum: { sellPrice: true, profit: true },
        _count: true,
      })
      const revenue = orders._sum.sellPrice || 0
      const grossProfit = orders._sum.profit || 0
      return {
        business_id: businessId,
        kpis: {
          total_monthly_salary: totalSalary,
          monthly_payroll_budget: totalSalary,
          unpaid_salary_hint: 0,
          period_salary_paid: totalSalary,
          period_advances: 0,
          advance_outstanding: 0,
          total_expenses: finance.total_expenses,
          monthly_revenue: revenue,
          order_gross_profit: grossProfit,
          employee_cost_budget: totalSalary,
          operational_expense: finance.total_expenses,
          net_operation_hint: grossProfit - finance.total_expenses,
          net_business_profit_hint: grossProfit - finance.total_expenses - totalSalary,
        },
        orders_summary: { delivered: orders._count },
        finance,
        employees_roll: payrollRoll(employees),
        payroll_timeline: [],
      }
    }

    case 'hr_payroll':
      return { transactions: [], total: 0 }

    case 'branding':
      return { branding: defaultBusinessBranding(businessId as BusinessId) }

    case 'audit_log':
      return { audit: [] }

    // CDIT is not part of the demo dataset — valid empty shapes keep the pages
    // rendering their empty states instead of throwing.
    case 'cdit_projects':
      return { projects: [] }
    case 'cdit_clients':
      return { clients: [] }
    case 'cdit_client':
      return { client: null }
    case 'cdit_invoices':
      return { invoices: [] }
    case 'cdit_payments':
      return { payments: [] }
    case 'cdit_dashboard':
      return { kpis: {}, projects: [], invoices: [] }

    default:
      // An unmapped read is a gap in this stub, not a reason to 500 the page.
      return { demo_stub: true, route, note: 'No demo data mapped for this route.' }
  }
}

function guard(req: NextRequest) {
  if (!isDemoDeployment()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const secret = new URL(req.url).searchParams.get('secret')
  const expected = process.env.API_SECRET
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied

  const params = new URL(req.url).searchParams
  const route = params.get('route') || ''
  const data = await handleRoute(route, params)
  return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
}

/**
 * Writes are accepted and dropped. A demo tester pressing "save" should see success,
 * not an error — and nothing they type should survive the nightly reset anyway.
 */
export async function POST(req: NextRequest) {
  const denied = guard(req)
  if (denied) return denied

  const route = new URL(req.url).searchParams.get('route') || ''
  return NextResponse.json({ ok: true, success: true, demo_stub: true, route })
}

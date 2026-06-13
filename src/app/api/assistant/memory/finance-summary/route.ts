import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  computeLedgerBalances,
  getMonthlyExpensesByCategory,
  formatAmount,
} from '@/agent/lib/finance-shared'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  try {
    const [balances, expensesByCategory] = await Promise.all([
      computeLedgerBalances(),
      getMonthlyExpensesByCategory(),
    ])

    const balanceRows = balances.map((b) => ({
      person: b.person,
      balances: b.balances,
      display: Object.entries(b.balances)
        .map(([c, v]) => {
          const sign = v >= 0 ? 'পাওনা' : 'দেনা'
          return `${b.person}: ${formatAmount(Math.abs(v), c)} (${sign})`
        })
        .join(' · '),
    }))

    const expenseRows = Object.entries(expensesByCategory).map(([key, total]) => {
      const [currency, category] = key.split(':')
      return { currency, category, total, display: `${formatAmount(total, currency)} — ${category}` }
    })

    return Response.json({
      balances: balanceRows,
      monthExpensesByCategory: expenseRows,
      asOf: new Date().toISOString(),
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

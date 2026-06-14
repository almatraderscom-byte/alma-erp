#!/usr/bin/env npx tsx
import { loadEnvFiles } from './env'
import { getLifestyleCustomers, getLifestyleOrders, getLifestyleProducts, getLifestyleStock } from '../../src/lib/lifestyle/read'
import { getLifestyleAnalytics, getLifestyleDashboard } from '../../src/lib/lifestyle/dashboard'

loadEnvFiles()

async function main() {
  const [orders, stock, products, customers, dash, analytics] = await Promise.all([
    getLifestyleOrders({ limit: '5' }),
    getLifestyleStock(),
    getLifestyleProducts(),
    getLifestyleCustomers({}),
    getLifestyleDashboard({}),
    getLifestyleAnalytics({}),
  ])
  console.log('[smoke] orders', orders.orders?.length, 'total', (orders.summary as { total?: number })?.total)
  console.log('[smoke] stock', stock.items?.length)
  console.log('[smoke] products', products.total)
  console.log('[smoke] customers', customers.customers?.length)
  console.log('[smoke] dashboard', dash.kpis.total_orders, 'revenue', dash.kpis.total_revenue)
  console.log('[smoke] analytics expenses', analytics.total_expenses ?? 'n/a')
  console.log('[smoke] PASS')
}

main().catch(err => {
  console.error('[smoke] FAIL', err)
  process.exit(1)
})

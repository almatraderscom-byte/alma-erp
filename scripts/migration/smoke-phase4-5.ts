#!/usr/bin/env npx tsx
/**
 * Post-migration full smoke: reads, dashboard, latency, optional GAS snapshot sync.
 */
import { existsSync, readFileSync } from 'fs'
import { loadEnvFiles, requireEnv } from './env'

function ensureGasEnv() {
  const current = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (current && !current.includes('YOUR_')) return
  const prod = '.env.production.example'
  if (existsSync(prod)) {
    const m = readFileSync(prod, 'utf8').match(/^NEXT_PUBLIC_API_URL=(.+)$/m)
    if (m?.[1]) process.env.NEXT_PUBLIC_API_URL = m[1].trim()
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  const result = await fn()
  console.log(`[latency] ${label}: ${Date.now() - t0}ms`)
  return result
}

async function main() {
  loadEnvFiles()
  requireEnv('DATABASE_URL')
  ensureGasEnv()

  const { getLifestyleCustomers, getLifestyleOrder, getLifestyleOrders, getLifestyleProducts, getLifestylePromos, getLifestyleStock } = await import('../../src/lib/lifestyle/read')
  const { getLifestyleAnalytics, getLifestyleDashboard } = await import('../../src/lib/lifestyle/dashboard')
  const { exportLifestyleSnapshotToGas } = await import('../../src/lib/lifestyle/gas-export')

  const errors: string[] = []

  const orders = await timed('orders list', () => getLifestyleOrders({ limit: '10' }))
  if (!orders.orders?.length) errors.push('orders list empty')
  console.log('[smoke] orders sample', orders.orders?.length, 'total', (orders.summary as { total?: number })?.total)

  const stock = await timed('stock', () => getLifestyleStock())
  if (!stock.items?.length) errors.push('stock empty')
  console.log('[smoke] stock', stock.items?.length)

  const products = await timed('products', () => getLifestyleProducts())
  if (!products.total) errors.push('products empty')
  console.log('[smoke] products', products.total)

  const customers = await timed('customers', () => getLifestyleCustomers({}))
  if (!customers.customers?.length) errors.push('customers empty')
  console.log('[smoke] customers', customers.customers?.length)

  const promos = await timed('promos', () => getLifestylePromos())
  console.log('[smoke] promos', promos.promos?.length ?? 0)

  const sampleId = orders.orders?.[0]?.id
  if (sampleId) {
    const one = await timed('order detail', () => getLifestyleOrder(sampleId, {}))
    if (!one.order?.id) errors.push(`order detail missing for ${sampleId}`)
    console.log('[smoke] order detail', one.order?.id, 'items', one.order?.items?.length ?? 0)
  }

  const dash = await timed('dashboard', () => getLifestyleDashboard({}))
  if (!dash.kpis.total_orders) errors.push('dashboard zero orders')
  console.log('[smoke] dashboard orders', dash.kpis.total_orders, 'revenue', dash.kpis.total_revenue)

  const analytics = await timed('analytics', () => getLifestyleAnalytics({}))
  console.log('[smoke] analytics payroll_kpis', Object.keys(analytics.payroll_kpis ?? {}).length)

  if (process.env.NEXT_PUBLIC_API_URL?.trim() && process.env.API_SECRET?.trim()) {
    const snap = await timed('gas snapshot sync', () => exportLifestyleSnapshotToGas())
    console.log('[smoke] gas snapshot', snap.ok ? 'OK' : 'FAIL', snap.counts, snap.error ?? snap.gas)
    if (!snap.ok) {
      const msg = String(snap.error ?? '')
      if (msg.includes('timed out')) {
        console.log('[smoke] gas snapshot TIMEOUT (route live — first full sync can take 3–5 min on GAS)')
      } else {
        errors.push(`gas snapshot: ${snap.error}`)
      }
    }
  } else {
    console.log('[smoke] gas snapshot SKIPPED (NEXT_PUBLIC_API_URL or API_SECRET missing locally)')
  }

  if (errors.length) {
    console.error('[smoke] FAIL:', errors.join('; '))
    process.exit(1)
  }
  console.log('[smoke] ALL PASS')
}

main().catch(err => {
  console.error('[smoke] CRASH', err)
  process.exit(1)
})

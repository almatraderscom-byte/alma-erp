#!/usr/bin/env npx tsx
/**
 * Deep-compare GAS vs Postgres read paths (flags ignored — always compares both).
 */
import { PrismaClient } from '@prisma/client'
import { loadEnvFiles } from './env'
import { gasGet } from './gas-client'
import {
  prismaCustomerToGas,
  prismaOrderToGas,
  prismaProductToGas,
  prismaStockToGas,
  stockSummaryFromItems,
} from '../../src/lib/lifestyle/prisma-mappers'

loadEnvFiles()

const db = new PrismaClient()

type Mismatch = { id: string; field: string; gas: unknown; pg: unknown }

function compareObjects(
  id: string,
  gas: Record<string, unknown>,
  pg: Record<string, unknown>,
  fields: string[],
  skipFields: string[] = [],
): Mismatch[] {
  const out: Mismatch[] = []
  for (const f of fields) {
    if (skipFields.includes(f)) continue
    const g = gas[f]
    const p = pg[f]
    if (JSON.stringify(g) !== JSON.stringify(p)) {
      out.push({ id, field: f, gas: g, pg: p })
    }
  }
  return out
}

async function compareStock() {
  const gas = await gasGet<{ items?: Array<Record<string, unknown>> }>('stock')
  const rows = await db.lifestyleStockItem.findMany()
  const pgItems = rows.map(prismaStockToGas)
  const gasCount = gas.items?.length ?? 0
  const pgCount = pgItems.length
  console.log(`\n=== stock: GAS=${gasCount} PG=${pgCount} countMatch=${gasCount === pgCount} ===`)
  if (gasCount !== pgCount) return false
  const sample = pgItems.slice(0, 10)
  let mismatches = 0
  for (const pg of sample) {
    const g = (gas.items ?? []).find(i => String(i.sku) === pg.sku && String(i.size ?? '') === pg.size)
    if (!g) { mismatches++; continue }
    const mm = compareObjects(`${pg.sku}|${pg.size}`, g, pg as unknown as Record<string, unknown>, [
      'sku', 'product', 'available', 'current_stock', 'reorder_level', 'stock_value',
    ])
    mismatches += mm.length
    mm.slice(0, 3).forEach(m => console.log(`  mismatch ${m.id} ${m.field}: gas=${m.gas} pg=${m.pg}`))
  }
  console.log(`  sample mismatches: ${mismatches}`)
  return mismatches === 0
}

async function compareProducts() {
  const gas = await gasGet<{ products?: Array<Record<string, unknown>>; total?: number }>('products')
  const rows = await db.lifestyleProduct.findMany()
  const pg = rows.map(prismaProductToGas)
  console.log(`\n=== products: GAS=${gas.total ?? gas.products?.length} PG=${pg.length} ===`)
  let mismatches = 0
  for (const p of pg) {
    const g = (gas.products ?? []).find(x => String(x.sku ?? x.id) === p.sku)
    if (!g) { mismatches++; continue }
    mismatches += compareObjects(p.sku, g, p as unknown as Record<string, unknown>, [
      'name', 'category', 'default_price', 'default_cogs', 'active',
    ]).length
  }
  console.log(`  field mismatches: ${mismatches}`)
  return mismatches === 0 && pg.length === (gas.products?.length ?? 0)
}

async function compareCustomers() {
  const gas = await gasGet<{ customers?: Array<Record<string, unknown>> }>('customers')
  const rows = await db.lifestyleCustomer.findMany()
  const pg = rows.map(prismaCustomerToGas)
  const gasImportable = (gas.customers ?? []).filter(c => c.id && c.phone).length
  console.log(`\n=== customers: GAS=${gas.customers?.length} PG=${pg.length} (importable~262) ===`)
  let mismatches = 0
  for (const c of pg.slice(0, 20)) {
    const g = (gas.customers ?? []).find(x => String(x.id) === c.id)
    if (!g) continue
    mismatches += compareObjects(c.id, g as Record<string, unknown>, c as unknown as Record<string, unknown>, [
      'name', 'phone', 'total_spent', 'segment',
    ]).length
  }
  console.log(`  sample mismatches: ${mismatches}`)
  return mismatches === 0
}

async function compareOrders() {
  const gas = await gasGet<{ orders?: Array<Record<string, unknown>> }>('orders', { limit: '50', offset: '0' })
  const rows = await db.lifestyleOrder.findMany({
    take: 50,
    orderBy: { id: 'asc' },
    include: { items: true },
  })
  const pg = rows.map(prismaOrderToGas)
  console.log(`\n=== orders sample: GAS batch=${gas.orders?.length} PG=${pg.length} ===`)
  const skip = ['sla_status', 'days_pending', 'days_in_transit', 'margin_pct']
  let mismatches = 0
  for (const p of pg) {
    const g = (gas.orders ?? []).find(x => String(x.id) === p.id)
    if (!g) { mismatches++; continue }
    mismatches += compareObjects(
      p.id,
      g,
      p as unknown as Record<string, unknown>,
      ['customer', 'phone', 'status', 'sell_price', 'profit', 'qty', 'sku'],
      skip,
    ).length
  }
  console.log(`  field mismatches (excl SLA): ${mismatches}`)
  return mismatches === 0
}

async function main() {
  console.log('[compare] GAS vs Postgres read-path shapes')
  const results = await Promise.all([
    compareStock(),
    compareProducts(),
    compareCustomers(),
    compareOrders(),
  ])
  const pass = results.every(Boolean)
  console.log(`\n=== Overall: ${pass ? 'PASS' : 'FAIL'} ===`)
  if (!pass) process.exitCode = 1
}

main()
  .finally(() => db.$disconnect())

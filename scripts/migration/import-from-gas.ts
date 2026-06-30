#!/usr/bin/env npx tsx
/**
 * One-time GAS → Postgres import (Phase 1).
 * GET-only against GAS; upserts into lifestyle_* tables.
 * Safe to re-run.
 */
import { PrismaClient } from '@prisma/client'
import { gasGet } from './gas-client'
import {
  mapGasCustomer,
  mapGasExpense,
  mapGasOrder,
  mapGasOrderItem,
  mapGasProduct,
  mapGasStockItem,
  type GasCustomer,
  type GasExpense,
  type GasOrder,
  type GasProduct,
  type GasStockItem,
} from './mappers'
import { loadEnvFiles } from './env'

loadEnvFiles()

const prisma = new PrismaClient()
const PAGE_SIZE = 500

type ImportStats = {
  read: number
  upserted: number
  skipped: number
  errors: Array<{ id: string; reason: string }>
}

function log(msg: string) {
  console.log(`[import] ${msg}`)
}

async function fetchAllOrders(): Promise<{ orders: GasOrder[]; total: number }> {
  const all: GasOrder[] = []
  let offset = 0
  let total = 0

  while (true) {
    const data = await gasGet<{
      orders?: GasOrder[]
      summary?: { total?: number }
    }>('orders', {
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    const batch = data.orders ?? []
    total = Number(data.summary?.total ?? batch.length)
    all.push(...batch)
    log(`orders page offset=${offset} batch=${batch.length} accumulated=${all.length}/${total}`)
    if (batch.length < PAGE_SIZE || all.length >= total) break
    offset += PAGE_SIZE
  }

  return { orders: all, total }
}

async function importOrders(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  const { orders, total } = await fetchAllOrders()
  stats.read = orders.length
  log(`orders GAS summary.total=${total}`)

  for (let i = 0; i < orders.length; i++) {
    const raw = orders[i]
    const id = String(raw.id ?? '').trim()
    try {
      const mapped = mapGasOrder(raw)
      await prisma.lifestyleOrder.upsert({
        where: { id: mapped.id },
        create: mapped,
        update: mapped,
      })

      await prisma.lifestyleOrderItem.deleteMany({ where: { orderId: mapped.id } })
      const items = raw.items ?? []
      for (let j = 0; j < items.length; j++) {
        const itemData = mapGasOrderItem(mapped.id, items[j], j)
        await prisma.lifestyleOrderItem.upsert({
          where: { orderId_lineNo: { orderId: mapped.id, lineNo: itemData.lineNo } },
          create: itemData,
          update: itemData,
        })
      }

      stats.upserted++
      if ((i + 1) % 50 === 0) log(`orders progress ${i + 1}/${orders.length}`)
    } catch (err) {
      stats.skipped++
      stats.errors.push({
        id: id || `row_${i}`,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return stats
}

async function importProducts(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  const data = await gasGet<{ products?: GasProduct[]; total?: number }>('products')
  const products = data.products ?? []
  stats.read = products.length
  log(`products GAS total=${data.total ?? products.length}`)

  for (let i = 0; i < products.length; i++) {
    const raw = products[i]
    const key = String(raw.sku || raw.id || `row_${i}`)
    try {
      const mapped = mapGasProduct(raw)
      await prisma.lifestyleProduct.upsert({
        where: { sku: mapped.sku },
        create: mapped,
        update: mapped,
      })
      stats.upserted++
    } catch (err) {
      stats.skipped++
      stats.errors.push({ id: key, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return stats
}

async function importStock(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  const data = await gasGet<{ items?: GasStockItem[]; summary?: { total_skus?: number } }>('stock')
  const items = data.items ?? []
  stats.read = items.length
  log(`stock GAS items=${items.length} summary.total_skus=${data.summary?.total_skus ?? 'n/a'}`)

  for (let i = 0; i < items.length; i++) {
    const raw = items[i]
    const key = `${raw.sku ?? ''}|${raw.size ?? ''}`
    try {
      const mapped = mapGasStockItem(raw)
      await prisma.lifestyleStockItem.upsert({
        where: { sku_size: { sku: mapped.sku, size: mapped.size } },
        create: mapped,
        update: mapped,
      })
      stats.upserted++
      if ((i + 1) % 100 === 0) log(`stock progress ${i + 1}/${items.length}`)
    } catch (err) {
      stats.skipped++
      stats.errors.push({ id: key, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return stats
}

async function importCustomers(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  const data = await gasGet<{ customers?: GasCustomer[]; summary?: { total?: number } }>('customers')
  const customers = data.customers ?? []
  stats.read = customers.length
  log(`customers GAS summary.total=${data.summary?.total ?? customers.length}`)

  for (let i = 0; i < customers.length; i++) {
    const raw = customers[i]
    const key = String(raw.id ?? `row_${i}`)
    try {
      const mapped = mapGasCustomer(raw)
      await prisma.lifestyleCustomer.upsert({
        where: { id: mapped.id },
        create: mapped,
        update: mapped,
      })
      stats.upserted++
      if ((i + 1) % 50 === 0) log(`customers progress ${i + 1}/${customers.length}`)
    } catch (err) {
      stats.skipped++
      stats.errors.push({ id: key, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return stats
}

async function importExpenses(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  // Wide range pulls the full ledger history in one GET (gasGet allows 120s).
  const data = await gasGet<{ expenses?: GasExpense[]; total_expenses?: number }>('finance', {
    startDate: '2015-01-01',
    endDate: new Date().toISOString().slice(0, 10),
  })
  const expenses = data.expenses ?? []
  stats.read = expenses.length
  log(`expenses GAS count=${expenses.length} total_expenses=${data.total_expenses ?? 'n/a'}`)

  for (let i = 0; i < expenses.length; i++) {
    const raw = expenses[i]
    const key = String(raw.exp_id ?? `row_${i}`)
    try {
      const mapped = mapGasExpense(raw)
      await prisma.lifestyleExpense.upsert({
        where: { legacySheetId: mapped.legacySheetId },
        create: mapped,
        update: mapped,
      })
      stats.upserted++
      if ((i + 1) % 100 === 0) log(`expenses progress ${i + 1}/${expenses.length}`)
    } catch (err) {
      stats.skipped++
      stats.errors.push({ id: key, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return stats
}

async function importPromos(): Promise<ImportStats> {
  const stats: ImportStats = { read: 0, upserted: 0, skipped: 0, errors: [] }
  try {
    const data = await gasGet<{ promos?: Array<Record<string, unknown>> }>('promos')
    const promos = data.promos ?? []
    stats.read = promos.length
    log(`promos GAS count=${promos.length}`)
    for (const p of promos) {
      const code = String(p.code ?? p.id ?? '').trim()
      if (!code) {
        stats.skipped++
        continue
      }
      await prisma.lifestylePromo.upsert({
        where: { businessId_code: { businessId: 'ALMA_LIFESTYLE', code } },
        create: {
          businessId: 'ALMA_LIFESTYLE',
          code,
          discountPct: p.discount_pct != null ? Math.round(Number(p.discount_pct)) : null,
          discountAmount: p.discount_amount != null ? Math.round(Number(p.discount_amount)) : null,
          active: p.active !== false,
          expiresAt: p.expires_at ? new Date(String(p.expires_at)) : null,
          usageCount: Math.round(Number(p.usage_count ?? 0)),
        },
        update: {
          discountPct: p.discount_pct != null ? Math.round(Number(p.discount_pct)) : null,
          discountAmount: p.discount_amount != null ? Math.round(Number(p.discount_amount)) : null,
          active: p.active !== false,
          expiresAt: p.expires_at ? new Date(String(p.expires_at)) : null,
          usageCount: Math.round(Number(p.usage_count ?? 0)),
        },
      })
      stats.upserted++
    }
  } catch (err) {
    log(`promos skipped (not deployed): ${err instanceof Error ? err.message : String(err)}`)
  }
  return stats
}

async function importInvoiceSequence(): Promise<void> {
  try {
    const data = await gasGet<{ next?: string }>('next_invoice_num')
    const next = String(data.next ?? '')
    const m = next.match(/^AL-INV-(\d{4})-(\d+)$/)
    if (!m) {
      log(`invoice sequence: could not parse next="${next}"`)
      return
    }
    const year = parseInt(m[1], 10)
    const nextNum = parseInt(m[2], 10)
    const lastNumber = Math.max(0, nextNum - 1)
    await prisma.lifestyleInvoiceSequence.upsert({
      where: { businessId_year: { businessId: 'ALMA_LIFESTYLE', year } },
      create: { businessId: 'ALMA_LIFESTYLE', year, lastNumber },
      update: { lastNumber },
    })
    log(`invoice sequence seeded year=${year} lastNumber=${lastNumber} (next=${next})`)
  } catch (err) {
    log(`invoice sequence skipped: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function printStats(label: string, stats: ImportStats) {
  console.log(`\n=== ${label} ===`)
  console.log(`  read:     ${stats.read}`)
  console.log(`  upserted: ${stats.upserted}`)
  console.log(`  skipped:  ${stats.skipped}`)
  if (stats.errors.length) {
    console.log(`  errors (${stats.errors.length}):`)
    for (const e of stats.errors.slice(0, 20)) {
      console.log(`    - ${e.id}: ${e.reason}`)
    }
    if (stats.errors.length > 20) console.log(`    ... and ${stats.errors.length - 20} more`)
  }
}

async function main() {
  log('Starting GAS → Postgres import (GET only)')
  const started = Date.now()

  const orders = await importOrders()
  const products = await importProducts()
  const stock = await importStock()
  const customers = await importCustomers()
  const expenses = await importExpenses()
  const promos = await importPromos()
  await importInvoiceSequence()

  printStats('Orders', orders)
  printStats('Products', products)
  printStats('Stock', stock)
  printStats('Customers', customers)
  printStats('Expenses', expenses)
  printStats('Promos', promos)

  const orderItems = await prisma.lifestyleOrderItem.count()
  console.log(`\nOrder items in Postgres: ${orderItems}`)
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

main()
  .catch(err => {
    console.error('[import] FATAL', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

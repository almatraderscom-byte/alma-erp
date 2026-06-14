#!/usr/bin/env npx tsx
/**
 * Verify lifestyle data counts.
 * Phase 1: compare Postgres import vs GAS (GAS should match or exceed).
 * Phase 3 (Option B): Postgres is authoritative — GAS may lag until nightly export.
 */
import { PrismaClient } from '@prisma/client'
import { gasGet } from './gas-client'
import { loadEnvFiles } from './env'
import { mapGasOrder, roundMoney, type GasOrder } from './mappers'

loadEnvFiles()

const prisma = new PrismaClient()

const MONEY_FIELDS = [
  'unitPrice', 'discount', 'addDiscount', 'advCost', 'sellPrice', 'shippingFee',
  'cogs', 'courierCharge', 'otherCosts', 'profit',
] as const

function log(msg: string) {
  console.log(`[verify] ${msg}`)
}

async function gasOrderTotal(): Promise<number> {
  const data = await gasGet<{ summary?: { total?: number }; orders?: GasOrder[] }>('orders', {
    limit: '1',
    offset: '0',
  })
  return Number(data.summary?.total ?? data.orders?.length ?? 0)
}

async function gasStockTotal(): Promise<number> {
  const data = await gasGet<{ items?: unknown[]; summary?: { total_skus?: number } }>('stock')
  return data.items?.length ?? 0
}

async function gasProductTotal(): Promise<number> {
  const data = await gasGet<{ products?: unknown[]; total?: number }>('products')
  return Number(data.total ?? data.products?.length ?? 0)
}

type GasCustomerRow = { id?: string; phone?: string; name?: string }

async function gasCustomerTotals(): Promise<{
  gasTotal: number
  importable: number
  skipped: Array<{ id: string; reason: string }>
}> {
  const data = await gasGet<{ customers?: GasCustomerRow[]; summary?: { total?: number } }>('customers')
  const customers = data.customers ?? []
  const gasTotal = Number(data.summary?.total ?? customers.length)
  const seenPhones = new Set<string>()
  const skipped: Array<{ id: string; reason: string }> = []
  let importable = 0

  for (const c of customers) {
    const id = String(c.id ?? '').trim()
    const phone = String(c.phone ?? '').trim()
    if (!id) {
      skipped.push({ id: '(blank)', reason: 'empty customer id' })
      continue
    }
    if (!phone) {
      skipped.push({ id, reason: 'empty phone' })
      continue
    }
    const phoneKey = phone
    if (seenPhones.has(phoneKey)) {
      skipped.push({ id, reason: `duplicate phone ${phone}` })
      continue
    }
    seenPhones.add(phoneKey)
    importable++
  }

  return { gasTotal, importable, skipped }
}

type CountCheck = {
  entity: string
  gasCount: number
  postgresCount: number
  match: boolean
  note?: string
}

async function countChecks(): Promise<CountCheck[]> {
  const [gasOrders, gasStock, gasProducts, gasCustomers] = await Promise.all([
    gasOrderTotal(),
    gasStockTotal(),
    gasProductTotal(),
    gasCustomerTotals(),
  ])

  const [pgOrders, pgStock, pgProducts, pgCustomers, pgOrderItems, pgPromos] = await Promise.all([
    prisma.lifestyleOrder.count(),
    prisma.lifestyleStockItem.count(),
    prisma.lifestyleProduct.count(),
    prisma.lifestyleCustomer.count(),
    prisma.lifestyleOrderItem.count(),
    prisma.lifestylePromo.count(),
  ])

  return [
    { entity: 'orders', gasCount: gasOrders, postgresCount: pgOrders, match: gasOrders === pgOrders },
    { entity: 'stock_items', gasCount: gasStock, postgresCount: pgStock, match: gasStock === pgStock },
    { entity: 'products', gasCount: gasProducts, postgresCount: pgProducts, match: gasProducts === pgProducts },
    {
      entity: 'customers',
      gasCount: gasCustomers.gasTotal,
      postgresCount: pgCustomers,
      match: gasCustomers.importable === pgCustomers,
      note:
        gasCustomers.importable === pgCustomers
          ? `importable=${gasCustomers.importable} (${gasCustomers.skipped.length} GAS rows skipped: empty id/phone or duplicate phone)`
          : `importable=${gasCustomers.importable} skipped=${gasCustomers.skipped.length}`,
    },
    {
      entity: 'order_items',
      gasCount: -1,
      postgresCount: pgOrderItems,
      match: true,
      note: 'GAS has no dedicated GET route; count is Postgres-only',
    },
    {
      entity: 'promos',
      gasCount: 0,
      postgresCount: pgPromos,
      match: true,
      note: 'promos route not deployed on GAS (expected 0)',
    },
  ]
}

async function spotCheckOrders(sampleSize = 5): Promise<void> {
  const orders = await prisma.lifestyleOrder.findMany({
    orderBy: { id: 'asc' },
    take: 200,
  })
  if (!orders.length) {
    log('spot-check: no orders in Postgres')
    return
  }

  const picks: string[] = []
  const step = Math.max(1, Math.floor(orders.length / sampleSize))
  for (let i = 0; i < orders.length && picks.length < sampleSize; i += step) {
    picks.push(orders[i].id)
  }

  log(`spot-check ${picks.length} orders: ${picks.join(', ')}`)

  for (const id of picks) {
    const gas = await gasGet<{ order?: GasOrder }>('order', { id })
    const pg = await prisma.lifestyleOrder.findUnique({ where: { id } })
    if (!gas.order) {
      console.log(`  ${id}: GAS missing order`)
      continue
    }
    if (!pg) {
      console.log(`  ${id}: Postgres missing order`)
      continue
    }

    const mapped = mapGasOrder(gas.order)
    const mismatches: string[] = []

    const scalarFields = [
      'customer', 'phone', 'status', 'product', 'qty', 'sellPrice', 'profit', 'sku',
    ] as const
    for (const f of scalarFields) {
      const gasVal = mapped[f]
      const pgVal = pg[f]
      if (String(gasVal) !== String(pgVal)) {
        mismatches.push(`${f}: gas=${gasVal} pg=${pgVal}`)
      }
    }

    for (const f of MONEY_FIELDS) {
      if (roundMoney(mapped[f]) !== roundMoney(pg[f])) {
        mismatches.push(`${f}: gas=${mapped[f]} pg=${pg[f]}`)
      }
    }

    if (mismatches.length) {
      console.log(`  ${id}: MISMATCH`)
      mismatches.forEach(m => console.log(`    - ${m}`))
    } else {
      console.log(`  ${id}: OK`)
    }
  }
}

async function main() {
  log('Verifying import counts')
  const checks = await countChecks()

  console.log('\n=== Count comparison ===')
  let allMatch = true
  for (const c of checks) {
    const gasLabel = c.gasCount >= 0 ? String(c.gasCount) : 'n/a'
    console.log(
      `${c.entity}: GAS=${gasLabel} Postgres=${c.postgresCount} match=${c.match}${c.note ? ` (${c.note})` : ''}`,
    )
    if (!c.match) allMatch = false
  }

  await spotCheckOrders(5)

  if (checks.find(c => c.entity === 'customers')?.note) {
    const cust = await gasCustomerTotals()
    if (cust.skipped.length) {
      console.log('\n=== Customer skips (documented) ===')
      for (const s of cust.skipped.slice(0, 25)) {
        console.log(`  ${s.id}: ${s.reason}`)
      }
      if (cust.skipped.length > 25) {
        console.log(`  ... and ${cust.skipped.length - 25} more`)
      }
    }
  }

  console.log(`\n=== Result: ${allMatch ? 'PASS' : 'FAIL'} ===`)
  if (!allMatch) process.exitCode = 1
}

main()
  .catch(err => {
    console.error('[verify] FATAL', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

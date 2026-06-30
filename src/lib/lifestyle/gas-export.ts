/**
 * Phase 3 Option B — nightly Postgres → GAS sheet snapshot export.
 */
import { prisma } from '@/lib/prisma'
import {
  prismaCustomerToGas,
  prismaExpenseToGas,
  prismaOrderToGas,
  prismaProductToGas,
  prismaStockToGas,
} from '@/lib/lifestyle/prisma-mappers'
import { serverPost } from '@/lib/server-api'
import { logEvent } from '@/lib/logger'

export type GasExportResult = {
  ok: boolean
  counts: { orders: number; stock: number; products: number; customers: number; expenses: number }
  gas?: Record<string, unknown>
  error?: string
}

export async function buildLifestyleGasSnapshot() {
  const [orders, stock, products, customers, expenses] = await Promise.all([
    prisma.lifestyleOrder.findMany({ orderBy: { date: 'asc' } }),
    prisma.lifestyleStockItem.findMany({ orderBy: { sku: 'asc' } }),
    prisma.lifestyleProduct.findMany({ orderBy: { sku: 'asc' } }),
    prisma.lifestyleCustomer.findMany({ orderBy: { id: 'asc' } }),
    prisma.lifestyleExpense.findMany({ where: { deletedAt: null }, orderBy: { expenseDate: 'asc' } }),
  ])
  return {
    orders: orders.map(prismaOrderToGas),
    stock: stock.map(prismaStockToGas),
    products: products.map(prismaProductToGas),
    customers: customers.map(prismaCustomerToGas),
    expenses: expenses.map(prismaExpenseToGas),
    exported_at: new Date().toISOString(),
  }
}

export async function exportLifestyleSnapshotToGas(): Promise<GasExportResult> {
  const snapshot = await buildLifestyleGasSnapshot()
  const counts = {
    orders: snapshot.orders.length,
    stock: snapshot.stock.length,
    products: snapshot.products.length,
    customers: snapshot.customers.length,
    expenses: snapshot.expenses.length,
  }
  try {
    const gas = await serverPost<Record<string, unknown>>('postgres_snapshot_sync', snapshot, {
      timeoutMs: 180_000,
    })
    if (gas?.error) {
      logEvent('error', 'migration.gas_nightly_export_failed', { error: String(gas.error), counts })
      return { ok: false, counts, gas, error: String(gas.error) }
    }
    logEvent('info', 'migration.gas_nightly_export_ok', { counts, gas })
    return { ok: true, counts, gas }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent('error', 'migration.gas_nightly_export_failed', { error: message, counts })
    return { ok: false, counts, error: message }
  }
}

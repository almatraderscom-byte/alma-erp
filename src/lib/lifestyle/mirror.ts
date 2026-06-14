import { serverGet } from '@/lib/server-api'
import type { Order, StockItem } from '@/types'
import {
  upsertCustomerFromGas,
  upsertOrderFromGas,
  upsertProductFromGas,
  upsertStockFromGasItem,
} from '@/lib/lifestyle/gas-upsert'
import { scheduleMirror } from '@/lib/lifestyle/mirror-log'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'

export function mirrorOrderAfterGasWrite(orderId: string): void {
  if (!orderId) return
  scheduleMirror(async () => {
    const data = await serverGet<{ order?: Order }>('order', { id: orderId }, 0)
    if (data.order) await upsertOrderFromGas(data.order)
  }, 'orders', { orderId })
}

export function mirrorAllStockAfterGasWrite(): void {
  scheduleMirror(async () => {
    const data = await serverGet<{ items?: StockItem[] }>('stock', {}, 0)
    for (const item of data.items ?? []) {
      await upsertStockFromGasItem(item as unknown as Record<string, unknown>)
    }
  }, 'stock')
}

export function mirrorProductAfterGasWrite(sku: string): void {
  if (!sku) return
  scheduleMirror(async () => {
    const data = await serverGet<{ products?: Array<Record<string, unknown>> }>('products', {}, 0)
    const row = (data.products ?? []).find(p => String(p.sku ?? p.id) === sku)
    if (row) await upsertProductFromGas(row)
    else mirrorAllStockAfterGasWrite()
  }, 'products', { sku })
}

export function mirrorCustomerAfterGasWrite(customerId?: string): void {
  scheduleMirror(async () => {
    if (customerId) {
      const data = await serverGet<{ customers?: Array<Record<string, unknown>> }>('customers', {}, 0)
      const row = (data.customers ?? []).find(c => String(c.id) === customerId)
      if (row) {
        try {
          await upsertCustomerFromGas(row)
        } catch {
          /* duplicate phone etc. — GAS truth preserved */
        }
        return
      }
    }
    const data = await serverGet<{ customers?: Array<Record<string, unknown>> }>('customers', {}, 0)
    const rows = data.customers ?? []
    const last = rows[rows.length - 1]
    if (last) {
      try { await upsertCustomerFromGas(last) } catch { /* skip bad rows */ }
    }
  }, 'customers', { customerId })
}

export function mirrorPromoAfterGasWrite(payload: Record<string, unknown>, result?: Record<string, unknown>): void {
  scheduleMirror(async () => {
    const code = String(result?.code ?? payload.code ?? result?.id ?? payload.id ?? '').trim()
    if (!code) return
    const id = String(result?.id ?? payload.id ?? code)
    await prisma.lifestylePromo.upsert({
      where: { businessId_code: { businessId: 'ALMA_LIFESTYLE', code } },
      create: {
        id,
        businessId: 'ALMA_LIFESTYLE',
        code,
        discountPct: payload.discount_pct != null ? roundMoney(Number(payload.discount_pct)) : null,
        discountAmount: payload.discount_amount != null ? roundMoney(Number(payload.discount_amount)) : null,
        active: payload.active !== false && payload.deactivate !== true && payload.delete !== true,
        expiresAt: payload.expires_at ? new Date(String(payload.expires_at)) : null,
        usageCount: roundMoney(Number(payload.usage_count ?? 0)),
      },
      update: {
        discountPct: payload.discount_pct != null ? roundMoney(Number(payload.discount_pct)) : undefined,
        discountAmount: payload.discount_amount != null ? roundMoney(Number(payload.discount_amount)) : undefined,
        active: payload.deactivate === true || payload.delete === true ? false : payload.active !== false,
        expiresAt: payload.expires_at ? new Date(String(payload.expires_at)) : undefined,
        usageCount: payload.usage_count != null ? roundMoney(Number(payload.usage_count)) : undefined,
      },
    })
  }, 'promos', { code: String(payload.code ?? '') })
}

export function mirrorOrderCreateResult(
  result: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  const orderId = String(result.order_id ?? result.id ?? payload.id ?? '')
  mirrorOrderAfterGasWrite(orderId)
}

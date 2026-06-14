/**
 * Pricing / margin insight from GAS products + stock buying prices + 30d sell velocity.
 */
import { getLifestyleProducts, getLifestyleStock } from '@/lib/lifestyle/read'
import type { ProductsResponse } from '@/lib/api'
import type { StockItem } from '@/types'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { roundMoney } from '@/lib/money'

export interface PricingInsight {
  thinMargin: Array<{ product: string; marginPct: number; sellPrice: number; suggestion: string }>
  highVolumeLowProfit: Array<{ product: string; units: number; marginPct: number }>
  flags: string[]
  costDataCoveragePct: number
  costDataMissing: boolean
}

const THIN_MARGIN_PCT = 15

export async function analyzePricing(): Promise<PricingInsight> {
  const [productsRes, stockRes, invSales] = await Promise.all([
    getLifestyleProducts().catch(() => ({ products: [] as ProductsResponse['products'] })),
    getLifestyleStock().catch(() => ({ items: [] as StockItem[] })),
    getInventoryWithSales(),
  ])

  const unitsMap = new Map(invSales.map((p) => [p.id, p.sales30d ?? 0]))
  const nameToSku = new Map(
    invSales.map((p) => [p.name.toLowerCase(), p.id]),
  )

  const stockBySku = new Map<string, StockItem>()
  for (const item of stockRes.items ?? []) {
    stockBySku.set(item.sku, item)
  }

  const thinMargin: PricingInsight['thinMargin'] = []
  const highVolumeLowProfit: PricingInsight['highVolumeLowProfit'] = []
  const flags: string[] = []

  let withCost = 0
  let checked = 0

  const rows = productsRes.products ?? []
  for (const p of rows) {
    if (p.active === false) continue
    const sku = String(p.sku ?? p.id ?? '').trim()
    if (!sku) continue

    const stock = stockBySku.get(sku)
    const sell = roundMoney(Number(p.default_price ?? 0))
    const cost = roundMoney(
      Number(p.default_cogs ?? 0) > 0
        ? Number(p.default_cogs)
        : Number(stock?.buyingPrice ?? 0),
    )
    const units = unitsMap.get(sku) ?? unitsMap.get(nameToSku.get(String(p.name).toLowerCase()) ?? '') ?? 0

    if (sell <= 0) continue
    checked++

    if (cost <= 0) continue
    withCost++

    const marginPct = Math.round(((sell - cost) / sell) * 1000) / 10
    const label = String(p.name || sku)

    if (marginPct < THIN_MARGIN_PCT) {
      thinMargin.push({
        product: label,
        marginPct,
        sellPrice: sell,
        suggestion: `মার্জিন কম (${marginPct}%) — দাম রিভিউ করুন বা cost কমান`,
      })
    }
    if (units >= 10 && marginPct < 20) {
      highVolumeLowProfit.push({ product: label, units, marginPct })
    }
  }

  const costDataCoveragePct = checked > 0 ? Math.round((withCost / checked) * 100) : 0
  const costDataMissing = checked > 0 && costDataCoveragePct < 40

  thinMargin.sort((a, b) => a.marginPct - b.marginPct)
  highVolumeLowProfit.sort((a, b) => b.units - a.units)

  if (costDataMissing) {
    flags.push(
      `অনেক product এ cost price নেই (${costDataCoveragePct}% coverage) — margin হিসাবের জন্য inventory তে buying price দিন`,
    )
  } else if (thinMargin.length) {
    flags.push(`${thinMargin.length}টি product এ margin ১৫% এর নিচে`)
  }

  if (highVolumeLowProfit.length && !costDataMissing) {
    const top = highVolumeLowProfit[0]
    flags.push(`${top.product} বেশি বিক্রি (${top.units}/৩০দিন) কিন্তু margin ${top.marginPct}%`)
  }

  return {
    thinMargin: thinMargin.slice(0, 10),
    highVolumeLowProfit: highVolumeLowProfit.slice(0, 10),
    flags,
    costDataCoveragePct,
    costDataMissing,
  }
}

/** Lightweight flags for morning briefing. */
export async function analyzePricingFlags(): Promise<Pick<PricingInsight, 'flags' | 'costDataMissing'>> {
  const full = await analyzePricing()
  return { flags: full.flags, costDataMissing: full.costDataMissing }
}

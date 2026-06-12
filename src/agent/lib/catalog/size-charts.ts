import { prisma } from '@/lib/prisma'
import { DEFAULT_CATALOG_BUSINESS, loadAllStockRows, resolveProductCode } from '@/agent/lib/catalog/inventory-lookup'
import { resolveSizeChartCategory } from '@/agent/lib/catalog/category-map'
import type { MemberRole } from '@/agent/lib/catalog/role-guess'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type SizeChartRow = {
  id: string
  business: string
  category: string
  ageMinYears: number
  ageMaxYears: number
  sizeLabel: string
  heightNote: string | null
}

function parseAgeRange(spec: string): { min: number; max: number } | null {
  const t = spec.trim().replace(/\s+/g, '')
  const m = t.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/)
  if (!m) return null
  return { min: Number(m[1]), max: Number(m[2]) }
}

export async function addSizeChartEntry(input: {
  business?: string
  category: string
  ageRange: string
  sizeLabel: string
  heightNote?: string
}) {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const ages = parseAgeRange(input.ageRange)
  if (!ages) return { ok: false as const, reason: 'invalid_age_range' }

  const row = await db.csSizeChart.create({
    data: {
      business,
      category: input.category.trim(),
      ageMinYears: ages.min,
      ageMaxYears: ages.max,
      sizeLabel: input.sizeLabel.trim(),
      heightNote: input.heightNote ?? null,
    },
  })
  return { ok: true as const, row }
}

export async function listSizeCharts(business = DEFAULT_CATALOG_BUSINESS, category?: string) {
  return db.csSizeChart.findMany({
    where: { business, ...(category ? { category } : {}) },
    orderBy: [{ category: 'asc' }, { ageMinYears: 'asc' }],
  })
}

export async function deleteSizeChartEntry(id: string) {
  await db.csSizeChart.delete({ where: { id } })
  return { deleted: true }
}

export async function importSizeChartsFromSeed(
  entries: Array<{
    business?: string
    category: string
    ageMinYears: number
    ageMaxYears: number
    sizeLabel: string
    heightNote?: string
  }>,
) {
  let inserted = 0
  for (const e of entries) {
    await db.csSizeChart.create({
      data: {
        business: e.business ?? DEFAULT_CATALOG_BUSINESS,
        category: e.category,
        ageMinYears: e.ageMinYears,
        ageMaxYears: e.ageMaxYears,
        sizeLabel: e.sizeLabel,
        heightNote: e.heightNote ?? null,
      },
    })
    inserted += 1
  }
  return { inserted }
}

export async function getSizeForAge(input: {
  productCode: string
  ageYears: number
  memberRole?: MemberRole | string
  business?: string
}) {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const resolved = await resolveProductCode(input.productCode)
  if (!resolved.ok) {
    return { success: false as const, reason: 'invalid_code' as const, suggestions: resolved.suggestions }
  }

  const category = resolveSizeChartCategory(resolved.row, input.memberRole)
  if (!category) {
    return { success: false as const, reason: 'chart_missing' as const, message: 'Product category could not be mapped to a size chart' }
  }

  const charts: SizeChartRow[] = await db.csSizeChart.findMany({
    where: { business, category },
    orderBy: { ageMinYears: 'asc' },
  })

  if (charts.length === 0) {
    return {
      success: false as const,
      reason: 'chart_missing' as const,
      category,
      message: `No size chart for category "${category}" — ask the owner to add via /sizechart`,
    }
  }

  const age = Number(input.ageYears)
  const match = charts.find((c) => age >= Number(c.ageMinYears) && age <= Number(c.ageMaxYears))
  if (!match) {
    return {
      success: false as const,
      reason: 'age_out_of_range' as const,
      category,
      availableRanges: charts.map((c) => `${c.ageMinYears}-${c.ageMaxYears} → ${c.sizeLabel}`),
    }
  }

  const allRows = await loadAllStockRows()
  const variants = allRows.filter((r) => r.sku === resolved.code)
  const sizeLabel = match.sizeLabel
  const inStock = variants.some(
    (v) =>
      v.currentStock > 0
      && (String(v.sizeValue) === sizeLabel || String(v.size) === sizeLabel || String(v.sizeValue).includes(sizeLabel)),
  )

  return {
    success: true as const,
    productCode: resolved.code,
    category,
    ageYears: age,
    sizeLabel,
    heightNote: match.heightNote,
    inStock,
    stockBySize: variants.map((v) => ({
      size: v.sizeValue || v.size,
      stock: v.currentStock,
    })),
  }
}

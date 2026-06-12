import type { CatalogStockRow } from '@/agent/lib/catalog/inventory-lookup'

/** Maps inventory row → size-chart category key. */
export function resolveSizeChartCategory(
  row: CatalogStockRow,
  memberRole?: string,
): string | null {
  const name = `${row.name} ${row.category}`.toLowerCase()
  const role = memberRole ?? ''
  const gender = row.genderType.toLowerCase() || row.collectionType.toLowerCase()

  if (/panjabi|পাঞ্জাবি|kurta|কুরতা/i.test(name)) {
    if (role === 'baba' || role === 'chele' || gender.includes('men') || /men|boy|ছেলে|বাবা/i.test(name)) {
      return 'boys_panjabi'
    }
    if (/boy|ছেলে|kid|child/i.test(name) || role === 'chele') return 'boys_panjabi'
    if (/men|man|বাবা|mens/i.test(name) || role === 'baba') return 'mens_panjabi'
    return 'mens_panjabi'
  }
  if (/dress|গাউন|frock|ফ্রক|salwar|শালোয়ার/i.test(name)) {
    return 'girls_dress'
  }
  if (/women|ladies|মহিলা|meye|মেয়ে/i.test(name) || role === 'ma' || role === 'meye') {
    return 'girls_dress'
  }
  if (row.category) {
    const c = row.category.toLowerCase().replace(/\s+/g, '_')
    if (c.includes('panjabi')) return gender.includes('women') ? 'girls_dress' : 'mens_panjabi'
    return c
  }
  return null
}

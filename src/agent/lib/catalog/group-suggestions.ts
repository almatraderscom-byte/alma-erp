import { loadCatalogStock, normalizeProductCode } from '@/agent/lib/catalog/inventory-lookup'
import { guessMemberRole } from '@/agent/lib/catalog/role-guess'

export type GroupSuggestion = {
  id: string
  title: string
  codes: string[]
  reason: string
  guessedRoles: Record<string, string>
}

/** Heuristic: same collectionCode, or shared name stem with role suffixes. */
export async function generateGroupSuggestions(limit = 20): Promise<GroupSuggestion[]> {
  const stock = await loadCatalogStock(true)
  const suggestions: GroupSuggestion[] = []
  const used = new Set<string>()

  // Group by collectionCode when 2+ SKUs share it
  const byCollection = new Map<string, typeof stock>()
  for (const row of stock) {
    const cc = String((row as { collectionType?: string }).collectionType ?? '').trim()
    const key = cc || extractNameStem(row.name)
    if (!key || key.length < 3) continue
    if (!byCollection.has(key)) byCollection.set(key, [])
    byCollection.get(key)!.push(row)
  }

  let idx = 0
  for (const [stem, rows] of byCollection) {
    if (rows.length < 2 || rows.length > 6) continue
    const codes = rows.map((r) => r.sku).sort()
    const sig = codes.join('|')
    if (used.has(sig)) continue
    used.add(sig)

    const roles: Record<string, string> = {}
    for (const r of rows) roles[r.sku] = guessMemberRole(r.name, r.sku)

    const distinctRoles = new Set(Object.values(roles).filter((r) => r !== 'other'))
    if (distinctRoles.size < 2 && rows.length > 2) continue

    suggestions.push({
      id: `sug-${++idx}`,
      title: rows[0]?.name?.split(/\s+/).slice(0, 4).join(' ') ?? stem,
      codes,
      reason: `Same design stem "${stem}" (${codes.length} products)`,
      guessedRoles: roles,
    })
    if (suggestions.length >= limit) break
  }

  // Suffix pattern: BASE-1, BASE-2 or FM204B, FM204C
  for (const row of stock) {
    const base = row.sku.replace(/[-_]?[BCMFG][0-9]*$/i, '').replace(/[-_]\d+$/, '')
    if (base.length < 3 || base === row.sku) continue
    const siblings = stock.filter(
      (r) => r.sku !== row.sku && (r.sku.startsWith(base) || normalizeProductCode(r.name).includes(base)),
    )
    if (siblings.length === 0) continue
    const codes = [row.sku, ...siblings.map((s) => s.sku)].sort()
    const sig = codes.join('|')
    if (used.has(sig)) continue
    used.add(sig)

    const roles: Record<string, string> = {}
    for (const r of [row, ...siblings]) roles[r.sku] = guessMemberRole(r.name, r.sku)

    suggestions.push({
      id: `sug-${++idx}`,
      title: `${base} family`,
      codes,
      reason: `Shared SKU prefix "${base}"`,
      guessedRoles: roles,
    })
    if (suggestions.length >= limit) break
  }

  return suggestions
}

function extractNameStem(name: string): string {
  return name
    .replace(/\b(baba|chele|ma|meye|men|women|boy|girl|couple)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30)
}

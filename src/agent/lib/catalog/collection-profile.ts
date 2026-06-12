import { sizeGroupForSize } from '@/components/orders/new-order/collection-engine'
import { roundMoney } from '@/lib/money'
import type { CatalogStockRow } from '@/agent/lib/catalog/inventory-lookup'

export type CollectionMemberRole =
  | 'adult_men'
  | 'kids'
  | 'orna'
  | 'two_piece'
  | 'three_piece'
  | 'other'

export type CollectionProfileKind = 'father_son' | 'women_family' | 'full_family' | 'custom'

const ROLE_LABELS_BN: Record<CollectionMemberRole, string> = {
  adult_men: 'বাবা/স্বামী (ADULT)',
  kids: 'ছেলে (KIDS)',
  orna: 'ওড়না (ORNA)',
  two_piece: 'দুই পিস (TWO PIECE)',
  three_piece: 'তিন পিস (THREE PIECE)',
  other: 'অন্যান্য',
}

export function inferCollectionMemberRole(row: CatalogStockRow): CollectionMemberRole {
  const blob = `${row.sku} ${row.name} ${row.size} ${row.sizeValue} ${row.sizeGroup} ${row.collectionType}`.toUpperCase()
  const suffix = row.sku.includes('-') ? row.sku.split('-').slice(1).join('-').toUpperCase() : ''

  if (/ORNA|ওড়না/.test(blob)) return 'orna'
  if (/THREE[\s-]?PIECE|3[\s-]?PIECE|3PC|3PEACH|তিন[\s-]?পিস/.test(blob)) return 'three_piece'
  if (/TWO[\s-]?PIECE|2[\s-]?PIECE|2PC|2PEACH|দুই[\s-]?পিস/.test(blob)) return 'two_piece'

  if (suffix === 'ADULT' || /\bADULT\b/.test(blob)) return 'adult_men'
  if (suffix === 'KIDS' || /\bKIDS\b|\bCHILD\b|ছেলে|CHELE|BOY/.test(blob)) return 'kids'

  const sizeToken = /^\d+$/.test(suffix) ? suffix : String(row.sizeValue || row.size || '').trim()
  const group = sizeGroupForSize(sizeToken)
  if (group === 'ADULT') return 'adult_men'
  if (group === 'KIDS') return 'kids'

  return 'other'
}

/** Merge size-level SKUs (133-42, 133-24) into pool rows per family role. */
export function consolidateCollectionMembers(members: CatalogStockRow[]): CatalogStockRow[] {
  const byKey = new Map<string, CatalogStockRow>()

  for (const row of members) {
    const role = inferCollectionMemberRole(row)
    const key = role === 'other' ? `other:${row.sku}` : role
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...row })
      continue
    }
    existing.currentStock += row.currentStock
    if (row.sellPrice > 0 && (existing.sellPrice <= 0 || row.sellPrice > existing.sellPrice)) {
      existing.sellPrice = row.sellPrice
    }
  }

  const order = ['adult_men', 'kids', 'orna', 'two_piece', 'three_piece'] as const
  const ordered = order.filter((r) => byKey.has(r)).map((r) => byKey.get(r)!)
  const extras = [...byKey.entries()]
    .filter(([k]) => k.startsWith('other:'))
    .map(([, v]) => v)
  return [...ordered, ...extras]
}

function detectProfileKind(roles: Set<CollectionMemberRole>): CollectionProfileKind {
  const hasMen = roles.has('adult_men') || roles.has('kids')
  const hasWomen = roles.has('orna') || roles.has('two_piece') || roles.has('three_piece')
  if (hasMen && hasWomen) return 'full_family'
  if (hasMen && roles.has('adult_men') && roles.has('kids') && !hasWomen) return 'father_son'
  if (hasWomen && !hasMen) return 'women_family'
  return 'custom'
}

export type CollectionMemberSummary = {
  code: string
  role: CollectionMemberRole
  roleLabelBn: string
  variant: string
  price: number
  stock: number
}

export type CollectionProfile = {
  kind: CollectionProfileKind
  kindLabelBn: string
  collectionCode: string
  memberCount: number
  members: CollectionMemberSummary[]
  totalPrice: number
  quoteHintBn: string
}

const KIND_LABELS: Record<CollectionProfileKind, string> = {
  father_son: 'বাবা-ছেলে কালেকশন (Father-Son)',
  women_family: 'মহিলা কালেকশন (ORNA/Two/Three Piece)',
  full_family: 'পূর্ণ ফ্যামিলি ম্যাচিং কালেকশন',
  custom: 'কাস্টম কালেকশন',
}

export function buildCollectionProfile(
  collectionCode: string,
  members: CatalogStockRow[],
): CollectionProfile {
  const consolidated = consolidateCollectionMembers(members)
  const summaries: CollectionMemberSummary[] = consolidated.map((m) => {
    const role = inferCollectionMemberRole(m)
    return {
      code: m.sku,
      role,
      roleLabelBn: ROLE_LABELS_BN[role],
      variant: m.size || m.sizeValue || m.sku.split('-').slice(1).join('-') || role,
      price: roundMoney(m.sellPrice),
      stock: m.currentStock,
    }
  })

  const roles = new Set(summaries.map((s) => s.role))
  const kind = detectProfileKind(roles)
  const totalPrice = roundMoney(summaries.reduce((s, m) => s + m.price, 0))

  let quoteHintBn =
    'প্রতিটি member-এর দাম আলাদা বলো, শেষে মোট যোগ করে full price দাও। কাস্টমারকে SKU suffix (133T, ADULT) বলতে বলবে না।'
  if (kind === 'father_son') {
    quoteHintBn =
      'বাবা-ছেলে কালেকশন — ADULT ও KIDS দাম আলাদা বলো, শেষে দুটোর যোগফল দাও। ছেলের বয়স/সাইজ জিজ্ঞেস করে KIDS সাইজ ঠিক করো; স্বামী/বাবার সাইজ ADULT।'
  } else if (kind === 'full_family') {
    quoteHintBn =
      'পূর্ণ ফ্যামিলি — কাস্টমার যাদের জন্য চায় (ছেলে বয়স, স্বামী সাইজ, নিজের জন্য two/three piece) inventory member roles অনুযায়ী মিলিয়ে প্রতিটির দাম বলো, শেষে সব মিলিয়ে মোট দাম দাও।'
  } else if (kind === 'women_family') {
    quoteHintBn =
      'মহিলা কালেকশন — ORNA / TWO PIECE / THREE PIECE আলাদা দাম বলো, শেষে মোট দাম দাও।'
  }

  return {
    kind,
    kindLabelBn: KIND_LABELS[kind],
    collectionCode,
    memberCount: summaries.length,
    members: summaries,
    totalPrice,
    quoteHintBn,
  }
}

/** When a single SKU belongs to a numeric family, expand to full collection for CS quoting. */
export function expandSkuToCollectionIfFamily(
  code: string,
  row: CatalogStockRow,
  rows: CatalogStockRow[],
  findMembers: (stem: string, all: CatalogStockRow[]) => CatalogStockRow[],
): { collectionCode: string; members: CatalogStockRow[] } | null {
  const stem =
    code.match(/^(\d+)T?-/i)?.[1]
    ?? String(row.collectionCode || '').replace(/T$/i, '').match(/^(\d+)$/)?.[1]
  if (!stem) return null
  const members = consolidateCollectionMembers(findMembers(stem, rows))
  if (members.length < 2) return null
  return { collectionCode: stem, members }
}

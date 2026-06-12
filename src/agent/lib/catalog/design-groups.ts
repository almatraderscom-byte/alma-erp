import { prisma } from '@/lib/prisma'
import {
  DEFAULT_CATALOG_BUSINESS,
  loadCatalogStock,
  normalizeProductCode,
  resolveProductCode,
} from '@/agent/lib/catalog/inventory-lookup'
import { guessMemberRole, type MemberRole } from '@/agent/lib/catalog/role-guess'
import { getPrimaryImageUrl } from '@/agent/lib/catalog/product-images'
import { loadAllStockRows } from '@/agent/lib/catalog/inventory-lookup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function nextGroupCode(business: string): Promise<string> {
  const count = await db.csDesignGroup.count({ where: { business } })
  return `FMG-${String(count + 1).padStart(3, '0')}`
}

export async function createOrExtendGroup(input: {
  codes: string[]
  title?: string
  notes?: string
  business?: string
  roles?: Record<string, MemberRole>
}): Promise<{ ok: true; group: Awaited<ReturnType<typeof getDesignGroup>> } | { ok: false; error: string }> {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const validCodes: Array<{ code: string; name: string }> = []

  for (const raw of input.codes) {
    const resolved = await resolveProductCode(raw)
    if (!resolved.ok) return { ok: false, error: `Invalid code: ${raw}` }
    validCodes.push({ code: resolved.code, name: resolved.row.name })
  }
  if (validCodes.length < 1) return { ok: false, error: 'At least one product code required' }

  const normalized = validCodes.map((v) => v.code)
  let group = await db.csDesignGroup.findFirst({
    where: {
      business,
      members: { some: { productCode: { in: normalized } } },
    },
    include: { members: true },
  })

  if (!group) {
    const groupCode = await nextGroupCode(business)
    group = await db.csDesignGroup.create({
      data: {
        groupCode,
        title: input.title ?? validCodes.map((v) => v.code).join(' + '),
        business,
        notes: input.notes ?? null,
      },
      include: { members: true },
    })
  } else if (input.title) {
    group = await db.csDesignGroup.update({
      where: { id: group.id },
      data: { title: input.title, notes: input.notes ?? group.notes },
      include: { members: true },
    })
  }

  for (const { code, name } of validCodes) {
    const exists = group.members.some((m: { productCode: string }) => m.productCode === code)
    if (exists) continue
    const role = input.roles?.[code] ?? guessMemberRole(name, code)
    await db.csDesignGroupMember.create({
      data: { groupId: group.id, productCode: code, memberRole: role },
    })
  }

  const full = await getDesignGroup({ codeOrGroup: group.groupCode, business })
  return { ok: true, group: full }
}

export async function setMemberRole(groupCodeOrId: string | undefined, productCode: string, role: MemberRole) {
  const code = normalizeProductCode(productCode)
  let group = null
  if (groupCodeOrId && /^FMG-/i.test(groupCodeOrId)) {
    group = await db.csDesignGroup.findFirst({
      where: { OR: [{ groupCode: groupCodeOrId }, { id: groupCodeOrId }] },
    })
  }
  if (!group) {
    const member = await db.csDesignGroupMember.findFirst({
      where: { productCode: code },
      include: { group: true },
    })
    group = member?.group ?? null
  }
  if (!group) return { ok: false as const, error: 'group_not_found' }

  await db.csDesignGroupMember.updateMany({
    where: { groupId: group.id, productCode: code },
    data: { memberRole: role },
  })
  return { ok: true as const, group: await getDesignGroup({ codeOrGroup: group.groupCode }) }
}

export async function getDesignGroup(input: { codeOrGroup: string; business?: string }) {
  const business = input.business ?? DEFAULT_CATALOG_BUSINESS
  const key = input.codeOrGroup.trim()
  const norm = normalizeProductCode(key)

  let group = await db.csDesignGroup.findFirst({
    where: { groupCode: key, business },
    include: { members: true },
  })

  if (!group) {
    const member = await db.csDesignGroupMember.findFirst({
      where: { productCode: norm },
      include: { group: { include: { members: true } } },
    })
    group = member?.group ?? null
  }

  if (!group) {
    // Fallback: prefix-based collection resolution from inventory
    const { resolveCollection } = await import('@/agent/lib/catalog/inventory-lookup')
    const collection = await resolveCollection(key)
    if (!collection) return null

    const allRows = await loadAllStockRows()

    const members = await Promise.all(
      collection.members.map(async (m) => {
        const variants = allRows.filter((r) => r.sku === m.code)
        return {
          productCode: m.code,
          memberRole: m.role,
          name: m.code,
          sellPrice: m.price,
          currentStock: m.stock,
          sizesInStock: variants.filter((v) => v.currentStock > 0).map((v) => v.sizeValue || v.size).filter(Boolean),
          primaryImageUrl: await getPrimaryImageUrl(m.code, business),
        }
      }),
    )

    return {
      groupCode: `AUTO-${collection.collectionCode}`,
      title: collection.kindLabelBn,
      notes: 'Auto-resolved from inventory prefix matching',
      business,
      members,
    }
  }

  const stock = await loadCatalogStock()
  const stockBySku = new Map(stock.map((s) => [s.sku, s]))
  const allRows = await loadAllStockRows()

  const members = await Promise.all(
    group.members.map(async (m: { productCode: string; memberRole: string }) => {
      const row = stockBySku.get(m.productCode)
      const variants = allRows.filter((r) => r.sku === m.productCode)
      const imageUrl = await getPrimaryImageUrl(m.productCode, business)
      return {
        productCode: m.productCode,
        memberRole: m.memberRole,
        name: row?.name ?? m.productCode,
        sellPrice: row?.sellPrice ?? 0,
        currentStock: variants.reduce((sum, v) => sum + v.currentStock, 0),
        sizesInStock: variants.filter((v) => v.currentStock > 0).map((v) => v.sizeValue || v.size).filter(Boolean),
        primaryImageUrl: imageUrl,
      }
    }),
  )

  return {
    groupCode: group.groupCode,
    title: group.title,
    notes: group.notes,
    business: group.business,
    members,
  }
}

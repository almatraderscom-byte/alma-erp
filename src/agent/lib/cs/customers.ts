import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CsCustomerRecord = {
  name: string | null
  phone: string | null
  addressLast: string | null
  sizesNoted: Record<string, string>
  ordersCount: number
  lastOrderAt: Date | null
  tags: string[]
}

export async function loadCsCustomer(pageId: string, psid: string): Promise<CsCustomerRecord | null> {
  const row = await db.csCustomer.findUnique({
    where: { pageId_psid: { pageId, psid } },
  })
  if (!row) return null
  return {
    name: row.name,
    phone: row.phone,
    addressLast: row.addressLast,
    sizesNoted: (row.sizesNoted as Record<string, string>) ?? {},
    ordersCount: row.ordersCount ?? 0,
    lastOrderAt: row.lastOrderAt,
    tags: Array.isArray(row.tags) ? row.tags as string[] : [],
  }
}

export function formatCustomerContextForPrompt(c: CsCustomerRecord | null): string {
  if (!c || c.ordersCount < 1) return ''
  const sizes = Object.entries(c.sizesNoted)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
  return (
    `\n## রিপিট কাস্টমার (শুধু এই কাস্টমারের নিজের ডেটা)\n` +
    `- আগের অর্ডার: ${c.ordersCount}টি` +
    (c.name ? `, নাম: ${c.name}` : '') +
    (sizes ? `\n- নোট করা সাইজ: ${sizes}` : '') +
    (c.addressLast ? `\n- শেষ ঠিকানা (রি-কনফার্ম করবেন, ধরে নেবেন না): ${c.addressLast}` : '') +
    `\n- স্বাভাবিকভাবে চিনে নিন কিন্তু ঠিকানা/সাইজ আবার জিজ্ঞেস করুন।`
  )
}

export async function upsertCsCustomerFromDraft(input: {
  pageId: string
  psid: string
  customerName?: string | null
  phone?: string | null
  address?: string | null
  sizesNoted?: Record<string, string>
}): Promise<void> {
  const existing = await db.csCustomer.findUnique({
    where: { pageId_psid: { pageId: input.pageId, psid: input.psid } },
  })

  const mergedSizes = {
    ...((existing?.sizesNoted as Record<string, string>) ?? {}),
    ...(input.sizesNoted ?? {}),
  }

  await db.csCustomer.upsert({
    where: { pageId_psid: { pageId: input.pageId, psid: input.psid } },
    create: {
      pageId: input.pageId,
      psid: input.psid,
      name: input.customerName ?? null,
      phone: input.phone ?? null,
      addressLast: input.address ?? null,
      sizesNoted: mergedSizes,
      ordersCount: 1,
      lastOrderAt: new Date(),
    },
    update: {
      name: input.customerName ?? existing?.name,
      phone: input.phone ?? existing?.phone,
      addressLast: input.address ?? existing?.addressLast,
      sizesNoted: mergedSizes,
      ordersCount: { increment: 1 },
      lastOrderAt: new Date(),
    },
  })
}

export function extractSizesFromItems(items: Array<{ variant?: string; code?: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of items) {
    const v = item.variant?.trim()
    if (!v) continue
    const code = (item.code ?? '').toLowerCase()
    if (code.includes('chele') || code.includes('boy') || v.includes('ছেলে')) out.chele = v
    else if (code.includes('meye') || code.includes('girl') || v.includes('মেয়ে')) out.meye = v
    else out.default = v
  }
  return out
}

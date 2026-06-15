/**
 * Creative reference library — competitor winners, own winners, File 14 playbook seeds.
 */
import { prisma } from '@/lib/prisma'
import { getDesignPlaybookLines } from '@/agent/lib/taste/distill'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import {
  searchAdsLibrary,
  extractSnapshotImageUrl,
  type AdLibraryAd,
} from '@/agent/lib/meta-ad-library'
import { describeReferenceCreative, type ReferenceAttrs } from '@/agent/lib/reference/vision'
import { resilientFetch } from '@/agent/lib/fetch-retry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type ReferenceAnchor = {
  id: string
  source: 'competitor' | 'own_winner' | 'seed' | 'playbook_seed'
  brand?: string | null
  attrs: ReferenceAttrs
  whyItWorks?: string | null
  imagePath?: string | null
  score: number
  productType?: string | null
}

const SOURCE_WEIGHT: Record<string, number> = {
  own_winner: 10,
  competitor: 6,
  seed: 4,
  playbook_seed: 3,
}

function normalizeProductType(raw?: string | null): string | null {
  const t = raw?.trim().toLowerCase()
  if (!t) return null
  if (/panjabi|punjabi|kurta/.test(t)) return 'panjabi'
  if (/family|matching/.test(t)) return 'family_set'
  if (/frock|saree|salwar/.test(t)) return t.split(/\s+/)[0]
  return t
}

function playbookLineToAttrs(line: string): ReferenceAttrs {
  const lower = line.toLowerCase()
  return {
    composition: /full-body|three-quarter/.test(lower) ? 'full-body' : 'centered',
    lighting: /golden|soft|studio/.test(lower) ? 'soft' : 'natural',
    background: /uncluttered|simple|hero/.test(lower) ? 'minimal' : 'studio-clean',
    mood: /premium|festival/.test(lower) ? 'premium' : 'casual',
    seed_text: line,
  }
}

export async function storeReferenceCreative(row: {
  source: 'competitor' | 'own_winner' | 'seed'
  imagePath?: string | null
  sourceUrl?: string | null
  brand?: string | null
  attrs: ReferenceAttrs
  whyItWorks?: string | null
  productType?: string | null
  score?: number
}): Promise<{ id: string }> {
  const created = await db.referenceCreative.create({
    data: {
      source: row.source,
      imagePath: row.imagePath ?? null,
      sourceUrl: row.sourceUrl ?? null,
      brand: row.brand ?? null,
      attrs: row.attrs,
      whyItWorks: row.whyItWorks ?? null,
      productType: normalizeProductType(row.productType),
      score: Math.min(5, Math.max(1, row.score ?? 3)),
    },
  })
  return { id: created.id as string }
}

async function downloadAndStoreImage(url: string, prefix: string): Promise<string | null> {
  try {
    const res = await resilientFetch(url, { timeoutMs: 15_000, retries: 1 })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 500) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    const ext = contentType.includes('png') ? 'png' : 'jpg'
    const path = `references/${prefix}-${Date.now()}.${ext}`
    await agentStorageUpload(path, buf, contentType, { upsert: true })
    return path
  } catch {
    return null
  }
}

async function processAdForReference(
  ad: AdLibraryAd,
  productType?: string | null,
): Promise<{ stored: boolean; id?: string; reason?: string }> {
  const existing = await db.referenceCreative.findFirst({
    where: { sourceUrl: ad.snapshotUrl ?? undefined, source: 'competitor' },
    select: { id: true },
  })
  if (existing) return { stored: false, reason: 'duplicate' }

  let imagePath: string | null = null
  let attrs: ReferenceAttrs = {}
  let whyItWorks = ''

  const imageUrl = ad.snapshotUrl ? await extractSnapshotImageUrl(ad.snapshotUrl) : null
  if (imageUrl) {
    imagePath = await downloadAndStoreImage(imageUrl, `comp-${ad.id.slice(0, 8)}`)
    if (imagePath) {
      const buf = await agentStorageDownload(imagePath)
      const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
      const described = await describeReferenceCreative(
        buf.toString('base64'),
        mime,
        ad.bodies?.[0],
      )
      attrs = described.attrs
      whyItWorks = described.whyItWorks
    }
  }

  if (!whyItWorks) {
    attrs = {
      ad_copy_sample: ad.bodies?.[0]?.slice(0, 200),
      page: ad.pageName,
      note: 'text-only — snapshot image unavailable',
    }
    whyItWorks =
      `Active ${ad.pageName ?? 'competitor'} ad in BD — copy-led reference; match premium garment-forward structure, not their branding.`
  }

  const { id } = await storeReferenceCreative({
    source: 'competitor',
    imagePath,
    sourceUrl: ad.snapshotUrl ?? null,
    brand: ad.pageName ?? null,
    attrs,
    whyItWorks,
    productType,
    score: imagePath ? 4 : 3,
  })
  return { stored: true, id }
}

export async function researchCompetitorCreatives(opts: {
  keyword?: string
  brand?: string
  productType?: string
  limit?: number
}): Promise<{
  searched: number
  stored: number
  ads: Array<{ id: string; pageName?: string; snapshotUrl?: string }>
  error?: string
  scopeGap?: boolean
  message: string
}> {
  const keyword = opts.keyword?.trim() || opts.productType?.trim() || 'panjabi'
  const search = await searchAdsLibrary({
    searchTerms: keyword,
    brand: opts.brand,
    limit: opts.limit ?? 6,
  })

  if (search.error && !search.ads.length) {
    return {
      searched: 0,
      stored: 0,
      ads: [],
      error: search.error,
      scopeGap: search.scopeGap,
      message: search.scopeGap
        ? `Ad Library unreachable: ${search.error}`
        : search.error,
    }
  }

  if (!search.ads.length) {
    return {
      searched: 0,
      stored: 0,
      ads: [],
      message: `Meta Ad Library-তে "${keyword}" (BD) জন্য active ad পাওয়া যায়নি — coverage thin; File 14 design playbook seeds ব্যবহার করুন।`,
    }
  }

  let stored = 0
  for (const ad of search.ads) {
    const result = await processAdForReference(ad, opts.productType ?? keyword)
    if (result.stored) stored += 1
  }

  return {
    searched: search.ads.length,
    stored,
    ads: search.ads.map((a) => ({
      id: a.id,
      pageName: a.pageName,
      snapshotUrl: a.snapshotUrl,
    })),
    message: stored
      ? `${stored}টি competitor reference সংরক্ষণ — pattern/structure শিখুন, clone করবেন না।`
      : `${search.ads.length}টি ad পাওয়া গেছে কিন্তু নতুন reference save হয়নি (duplicate বা image unavailable)।`,
  }
}

export async function getTopReferences(
  productType?: string | null,
  n = 3,
): Promise<ReferenceAnchor[]> {
  const normalized = normalizeProductType(productType)
  const take = Math.min(Math.max(n, 1), 5)

  const where = normalized
    ? {
        OR: [
          { productType: normalized },
          { productType: null },
        ],
      }
    : {}

  const rows = await db.referenceCreative.findMany({
    where,
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    take: 20,
  }) as Array<{
    id: string
    source: string
    brand: string | null
    attrs: ReferenceAttrs
    whyItWorks: string | null
    imagePath: string | null
    score: number
    productType: string | null
    createdAt: Date
  }>

  const ranked = rows
    .map((r) => ({
      id: r.id,
      source: r.source as ReferenceAnchor['source'],
      brand: r.brand,
      attrs: r.attrs,
      whyItWorks: r.whyItWorks,
      imagePath: r.imagePath,
      score: r.score + (SOURCE_WEIGHT[r.source] ?? 0),
      productType: r.productType,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime())

  const anchors: ReferenceAnchor[] = ranked.slice(0, take).map(({ createdAt: _, ...rest }) => rest)

  if (anchors.length < take) {
    const playbookLines = await getDesignPlaybookLines()
    for (const line of playbookLines) {
      if (anchors.length >= take) break
      if (anchors.some((a) => a.whyItWorks === line || a.attrs?.seed_text === line)) continue
      anchors.push({
        id: `playbook:${line.slice(0, 24)}`,
        source: 'playbook_seed',
        attrs: playbookLineToAttrs(line),
        whyItWorks: line,
        score: SOURCE_WEIGHT.playbook_seed,
        productType: normalized,
      })
    }
  }

  return anchors.slice(0, take)
}

export function buildReferencePromptBlock(refs: ReferenceAnchor[]): string {
  if (!refs.length) return ''
  const lines = refs.map((r, i) => {
    const src =
      r.source === 'own_winner' ? 'YOUR proven winner'
      : r.source === 'competitor' ? `market reference${r.brand ? ` (${r.brand})` : ''}`
      : 'proven best-practice'
    const attrs = [
      r.attrs.composition && `composition:${r.attrs.composition}`,
      r.attrs.lighting && `lighting:${r.attrs.lighting}`,
      r.attrs.background && `background:${r.attrs.background}`,
      r.attrs.crop && `crop:${r.attrs.crop}`,
      r.attrs.mood && `mood:${r.attrs.mood}`,
    ].filter(Boolean).join(', ')
    const why = r.whyItWorks ?? attrs
    return `${i + 1}. [${src}] ${why}${attrs ? ` (${attrs})` : ''}`
  })
  return (
    `PROVEN REFERENCE STYLES — match these on-market visual structures for composition/lighting/mood; ` +
    `apply to ALMA garments and brand — do NOT clone competitor logos/copy/branding: ${lines.join(' | ')}`
  )
}

export async function promoteOwnWinnerReference(args: {
  productCode?: string | null
  imagePath?: string | null
  roas?: number
  ctr?: number
  angle?: string
}): Promise<{ id: string } | null> {
  const WINNER_ROAS = 3.2
  if (args.roas != null && args.roas < WINNER_ROAS) return null

  let imagePath = args.imagePath?.trim() || null
  if (!imagePath && args.productCode) {
    try {
      const { loadProductAsset } = await import('@/lib/content-engine/pipeline')
      const product = await loadProductAsset(args.productCode)
      imagePath = product?.imagePath ?? null
    } catch { /* optional */ }
  }
  if (!imagePath) return null

  const dup = await db.referenceCreative.findFirst({
    where: { source: 'own_winner', imagePath, productType: normalizeProductType(args.productCode) },
  })
  if (dup) return { id: dup.id as string }

  let attrs: ReferenceAttrs = { angle: args.angle, roas: args.roas, ctr: args.ctr }
  let whyItWorks = `Own ad winner — ROAS ${args.roas?.toFixed(1) ?? '?'}x; reuse this proven visual structure for ${args.productCode ?? 'similar products'}.`

  try {
    const buf = await agentStorageDownload(imagePath)
    const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const described = await describeReferenceCreative(buf.toString('base64'), mime, args.angle ?? null)
    attrs = { ...described.attrs, roas: args.roas, ctr: args.ctr, angle: args.angle }
    whyItWorks = described.whyItWorks
  } catch { /* text-only fallback */ }

  const { id } = await storeReferenceCreative({
    source: 'own_winner',
    imagePath,
    brand: 'ALMA',
    attrs,
    whyItWorks,
    productType: args.productCode ?? null,
    score: args.roas != null && args.roas >= 4 ? 5 : 4,
  })
  return { id }
}

export async function listReferenceLibrary(opts?: {
  source?: string
  productType?: string
  limit?: number
}): Promise<ReferenceAnchor[]> {
  const where: Record<string, unknown> = {}
  if (opts?.source) where.source = opts.source
  if (opts?.productType) where.productType = normalizeProductType(opts.productType)

  const rows = await db.referenceCreative.findMany({
    where,
    orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    take: opts?.limit ?? 25,
  }) as Array<{
    id: string
    source: string
    brand: string | null
    attrs: ReferenceAttrs
    whyItWorks: string | null
    imagePath: string | null
    score: number
    productType: string | null
  }>

  return rows.map((r) => ({
    id: r.id,
    source: r.source as ReferenceAnchor['source'],
    brand: r.brand,
    attrs: r.attrs,
    whyItWorks: r.whyItWorks,
    imagePath: r.imagePath,
    score: r.score,
    productType: r.productType,
  }))
}

export async function pruneReference(id: string): Promise<boolean> {
  try {
    await db.referenceCreative.delete({ where: { id } })
    return true
  } catch {
    return false
  }
}

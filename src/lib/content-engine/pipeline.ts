import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { resolvePageId } from '@/agent/lib/meta'
import { upcomingSeasons } from '@/lib/marketing-calendar'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { trackOutcome } from '@/lib/outcome-loop'
import { trackPublishedContent } from '@/lib/content-intelligence'
import { applyBrandFrame, type BrandTheme } from '@/lib/content-engine/brand-frame'
import { generateCaption } from '@/lib/content-engine/caption'
import {
  generateProductVariants,
  PHASE1_VARIANTS,
  variantLabel,
  type ContentVariant,
  type ProductAsset,
  type RenderQuality,
} from '@/lib/content-engine/generate-variants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type PipelineVariantState = {
  key: ContentVariant
  rawImagePath: string | null
  framedImagePath: string | null
  renderActionId: string | null
}

export type ContentPipelinePayload = {
  pipelineId: string
  productCode: string
  variants: PipelineVariantState[]
  theme: BrandTheme
  hook?: string
  stage: 'draft_rendering' | 'gate1_ready' | 'pro_rendering' | 'gate2_ready' | 'published'
  qualityPass: RenderQuality
  page: 'lifestyle' | 'onlineshop'
  conversationId?: string | null
  caption?: string
  gate2Id?: string
}

function isFridayDhaka(now = new Date()): boolean {
  const wd = now.toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka', weekday: 'short' })
  return wd === 'Fri'
}

export async function resolveContentTheme(): Promise<{ theme: BrandTheme; hook: string }> {
  const seasons = await upcomingSeasons()
  const active = seasons.find((s) => s.inLeadWindow)
  if (active?.key === 'eid_fitr' || active?.key === 'eid_adha') {
    return { theme: 'eid', hook: 'ঈদ স্পেশাল কালেকশন' }
  }
  if (active?.key === 'pahela_baishakh') return { theme: 'boishakh', hook: 'পহেলা বৈশাখ স্পেশাল' }
  if (active?.key === 'puja') return { theme: 'puja', hook: 'পূজা স্পেশাল' }
  if (active?.key === 'winter') return { theme: 'winter', hook: 'শীত কালেকশন' }
  if (isFridayDhaka()) return { theme: 'default', hook: 'জুম্মার দিন — নতুন কালেকশন' }
  return { theme: 'default', hook: 'নতুন কালেকশন' }
}

export async function loadProductAsset(productCode?: string): Promise<ProductAsset | null> {
  if (productCode) {
    const row = await db.productContentAsset.findFirst({
      where: { productCode: productCode.trim() },
    })
    return row ? mapProduct(row) : null
  }
  const row = await db.productContentAsset.findFirst({
    orderBy: [{ lastPostedAt: 'asc' }, { createdAt: 'asc' }],
  })
  return row ? mapProduct(row) : null
}

function mapProduct(row: {
  productCode: string
  name: string | null
  category: string | null
  fabric: string | null
  imagePath: string
  familyMatch: boolean
}): ProductAsset {
  return {
    productCode: row.productCode,
    name: row.name,
    category: row.category,
    fabric: row.fabric,
    imagePath: row.imagePath,
    familyMatch: row.familyMatch,
  }
}

async function queueVariantRenders(args: {
  product: ProductAsset
  variants: ContentVariant[]
  quality: RenderQuality
  pipelineId: string
  gate1Id: string
  theme: BrandTheme
  conversationId?: string | null
}): Promise<string[]> {
  const specs = await generateProductVariants({
    product: args.product,
    variants: args.variants,
    quality: args.quality,
    style: args.theme === 'eid' || args.theme === 'puja' ? 'festival' : 'studio',
  })

  const actionIds: string[] = []
  for (const spec of specs) {
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: args.conversationId ?? null,
        type: 'image_gen',
        payload: {
          prompt: spec.prompt,
          quality: spec.quality,
          referenceImageId: spec.modelImagePath,
          secondReferenceImageId: spec.productImagePath,
          tryOn: true,
          conversationId: args.conversationId ?? null,
          contentPipeline: {
            pipelineId: args.pipelineId,
            gate1Id: args.gate1Id,
            variant: spec.variant,
            quality: args.quality,
            productCode: args.product.productCode,
            theme: args.theme,
          },
        },
        summary: `Content ${spec.quality}: ${variantLabel(spec.variant)}`,
        costEstimate: spec.costEstimate,
        status: 'approved',
        resolvedAt: new Date(),
      },
    })
    actionIds.push(action.id)
  }
  return actionIds
}

function updateVariantRenderId(payload: ContentPipelinePayload, variant: ContentVariant, actionId: string) {
  const v = payload.variants.find((x) => x.key === variant)
  if (v) v.renderActionId = actionId
}

export async function startContentPipeline(opts: {
  productCode?: string
  conversationId?: string | null
  page?: 'lifestyle' | 'onlineshop'
  variants?: ContentVariant[]
}): Promise<{ gate1Id: string; pipelineId: string; productCode: string }> {
  const product = await loadProductAsset(opts.productCode)
  if (!product) throw new Error('product_not_found')

  const variants = opts.variants ?? PHASE1_VARIANTS
  const { theme, hook } = await resolveContentTheme()
  const pipelineId = randomUUID()
  const page = opts.page ?? 'lifestyle'

  const payload: ContentPipelinePayload = {
    pipelineId,
    productCode: product.productCode,
    variants: variants.map((key) => ({
      key,
      rawImagePath: null,
      framedImagePath: null,
      renderActionId: null,
    })),
    theme,
    hook,
    stage: 'draft_rendering',
    qualityPass: 'draft',
    page,
    conversationId: opts.conversationId ?? null,
  }

  const gate1 = await db.agentPendingAction.create({
    data: {
      conversationId: opts.conversationId ?? null,
      type: 'content_gate1',
      payload,
      summary:
        `📸 কন্টেন্ট পোস্ট — Gate 1 (ছবি)\n` +
        `প্রোডাক্ট: ${product.productCode}\n` +
        `ভ্যারিয়েন্ট: ${variants.map(variantLabel).join(', ')}\n` +
        `Draft রেন্ডার হচ্ছে…`,
      costEstimate: variants.length * 1.1,
      status: 'pending',
    },
  })

  const actionIds = await queueVariantRenders({
    product,
    variants,
    quality: 'draft',
    pipelineId,
    gate1Id: gate1.id,
    theme,
    conversationId: opts.conversationId,
  })

  for (let i = 0; i < variants.length; i++) {
    updateVariantRenderId(payload, variants[i], actionIds[i])
  }
  await db.agentPendingAction.update({
    where: { id: gate1.id },
    data: { payload },
  })

  return { gate1Id: gate1.id, pipelineId, productCode: product.productCode }
}

async function buildGate1Summary(productCode: string, payload: ContentPipelinePayload): Promise<string> {
  const lines = [
    `📸 কন্টেন্ট পোস্ট — Gate 1 (ছবি অনুমোদন)`,
    `প্রোডাক্ট: ${productCode}`,
    `থিম: ${payload.theme} | ${payload.hook ?? ''}`,
    '',
    'ভ্যারিয়েন্ট:',
  ]
  for (const v of payload.variants) {
    const path = v.framedImagePath ?? v.rawImagePath
    if (path) {
      try {
        const url = await agentStorageSignedUrl(path, 3600)
        lines.push(`• ${variantLabel(v.key)}: ![${v.key}](${url})`)
      } catch {
        lines.push(`• ${variantLabel(v.key)}: ${path}`)
      }
    }
  }
  lines.push('', 'ফ্যাব্রিক/লুক ঠিক আছে কিনা দেখুন — Approve করলে PRO রেন্ডার + ক্যাপশন হবে।')
  return lines.join('\n')
}

export async function onPipelineRenderComplete(
  renderActionId: string,
  storagePath: string,
): Promise<void> {
  const renderAction = await db.agentPendingAction.findUnique({ where: { id: renderActionId } })
  if (!renderAction) return
  const rp = renderAction.payload as {
    contentPipeline?: {
      gate1Id: string
      variant: ContentVariant
      quality: RenderQuality
      productCode: string
      theme: BrandTheme
      hook?: string
    }
  }
  const cp = rp.contentPipeline
  if (!cp?.gate1Id) return

  const gate1 = await db.agentPendingAction.findUnique({ where: { id: cp.gate1Id } })
  if (!gate1 || gate1.type !== 'content_gate1') return

  const payload = gate1.payload as ContentPipelinePayload
  const variant = payload.variants.find((v) => v.key === cp.variant)
  if (!variant) return

  variant.rawImagePath = storagePath
  const product = await loadProductAsset(payload.productCode)
  if (!product) return

  variant.framedImagePath = await applyBrandFrame(storagePath, {
    productCode: payload.productCode,
    hook: payload.hook,
    theme: payload.theme,
    footer: false,
  })

  const allDone = payload.variants.every((v) => v.framedImagePath)
  if (!allDone) {
    await db.agentPendingAction.update({ where: { id: gate1.id }, data: { payload } })
    return
  }

  if (payload.qualityPass === 'draft') {
    payload.stage = 'gate1_ready'
    const summary = await buildGate1Summary(payload.productCode, payload)
    await db.agentPendingAction.update({
      where: { id: gate1.id },
      data: { payload, summary },
    })
    await sendOwnerText(`📸 কন্টেন্ট Gate 1 প্রস্তুত — ${payload.productCode}\nছবি দেখে Approve করুন (ফ্যাব্রিক ঠিক না হলে আবার বলুন)।`)
    return
  }

  // Pro pass complete → caption + gate2
  payload.stage = 'gate2_ready'
  const captionResult = await generateCaption(product, {
    theme: payload.theme,
    hook: payload.hook,
    page: payload.page,
  })
  payload.caption = captionResult.caption
  payload.hook = captionResult.hook

  const imageLines: string[] = []
  for (const v of payload.variants) {
    if (!v.framedImagePath) continue
    try {
      const url = await agentStorageSignedUrl(v.framedImagePath, 3600)
      imageLines.push(`![${v.key}](${url})`)
    } catch {
      imageLines.push(v.framedImagePath)
    }
  }

  const primaryImage = payload.variants.find((v) => v.key === 'single')?.framedImagePath
    ?? payload.variants[0]?.framedImagePath
    ?? null

  const gate2 = await db.agentPendingAction.create({
    data: {
      conversationId: payload.conversationId ?? null,
      type: 'content_gate2',
      payload: {
        pipelineId: payload.pipelineId,
        gate1Id: gate1.id,
        productCode: payload.productCode,
        page: payload.page,
        pageId: resolvePageId(payload.page),
        message: captionResult.caption,
        hook: captionResult.hook,
        imagePaths: payload.variants.map((v) => v.framedImagePath).filter(Boolean),
        primaryImagePath: primaryImage,
        conversationId: payload.conversationId,
      },
      summary:
        `📣 কন্টেন্ট পোস্ট — Gate 2 (ফাইনাল)\n` +
        `প্রোডাক্ট: ${payload.productCode}\n` +
        `ক্যাপশন:\n${captionResult.caption.slice(0, 400)}`,
      status: 'pending',
    },
  })

  payload.gate2Id = gate2.id
  await db.agentPendingAction.update({
    where: { id: gate1.id },
    data: { payload, status: 'executed', resolvedAt: new Date() },
  })

  await sendOwnerText(
    `📣 কন্টেন্ট Gate 2 প্রস্তুত — ${payload.productCode}\n` +
    `${imageLines.join('\n')}\n\n${captionResult.caption.slice(0, 500)}`,
  )
}

export async function advanceToProRenders(gate1Id: string): Promise<{ queued: boolean; message: string }> {
  const gate1 = await db.agentPendingAction.findUnique({ where: { id: gate1Id } })
  if (!gate1 || gate1.type !== 'content_gate1') throw new Error('invalid_gate1')
  const payload = gate1.payload as ContentPipelinePayload
  if (payload.stage !== 'gate1_ready') throw new Error('gate1_not_ready')

  const product = await loadProductAsset(payload.productCode)
  if (!product) throw new Error('product_not_found')

  payload.stage = 'pro_rendering'
  payload.qualityPass = 'pro'
  for (const v of payload.variants) {
    v.rawImagePath = null
    v.framedImagePath = null
    v.renderActionId = null
  }

  const variants = payload.variants.map((v) => v.key)
  const actionIds = await queueVariantRenders({
    product,
    variants,
    quality: 'pro',
    pipelineId: payload.pipelineId,
    gate1Id,
    theme: payload.theme,
    conversationId: payload.conversationId,
  })
  for (let i = 0; i < variants.length; i++) {
    updateVariantRenderId(payload, variants[i], actionIds[i])
  }

  await db.agentPendingAction.update({
    where: { id: gate1Id },
    data: {
      status: 'approved',
      resolvedAt: new Date(),
      payload,
      summary: `📸 Gate 1 অনুমোদিত — PRO রেন্ডার হচ্ছে (${payload.productCode})`,
    },
  })

  return {
    queued: true,
    message: 'Gate 1 approved — PRO renders queued. Gate 2 will arrive when renders finish.',
  }
}

export async function publishContentGate2(gate2Id: string): Promise<{ postId: string }> {
  const gate2 = await db.agentPendingAction.findUnique({ where: { id: gate2Id } })
  if (!gate2 || gate2.type !== 'content_gate2') throw new Error('invalid_gate2')
  const payload = gate2.payload as {
    productCode: string
    page: string
    pageId: string
    message: string
    primaryImagePath: string | null
  }

  const { createPagePost, verifyPost } = await import('@/agent/lib/meta')
  const { postId, postedAsPhoto } = await createPagePost({
    pageId: payload.pageId,
    message: payload.message,
    imageUrl: payload.primaryImagePath ?? undefined,
    requireImage: Boolean(payload.primaryImagePath),
  })
  const verified = await verifyPost(payload.pageId, postId)

  await db.productContentAsset.updateMany({
    where: { productCode: payload.productCode },
    data: { lastPostedAt: new Date() },
  })

  void trackPublishedContent({
    productRef: payload.productCode,
    message: payload.message,
    contentType: postedAsPhoto ? 'fb_photo' : 'fb_text',
    page: payload.page,
  }).catch(() => {})

  void trackOutcome({
    type: 'content',
    subjectKind: 'product',
    subjectId: payload.productCode,
    subjectName: payload.productCode,
    suggestion: `FB content post ${todayYmdDhaka()}`,
    metric: 'engagement',
    measureAfterDays: 7,
  }).catch(() => {})

  await db.agentPendingAction.update({
    where: { id: gate2Id },
    data: {
      status: 'executed',
      resolvedAt: new Date(),
      result: { postId, verified: verified.ok, hasMedia: verified.hasMedia },
    },
  })

  return { postId }
}

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { sendOwnerApprovalCard } from '@/agent/lib/telegram-owner-notify'
import { resolvePageId } from '@/agent/lib/meta'
import { trackPublishedContent } from '@/lib/content-intelligence'
import { applyBrandFrame, type BrandTheme } from '@/lib/content-engine/brand-frame'
import { generateCaption } from '@/lib/content-engine/caption'
import { resolveTheme, type ResolvedContentTheme } from '@/lib/content-engine/theme'
import {
  getContentEngineConfig,
  variantsForProduct,
} from '@/lib/content-engine/config'
import {
  generateProductVariants,
  PHASE1_VARIANTS,
  PHASE2_FULL_VARIANTS,
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
  /** Owner keeps this variant for PRO pass (default true when image ready). */
  keep: boolean
}

export type ContentPipelinePayload = {
  pipelineId: string
  productCode: string
  variants: PipelineVariantState[]
  theme: BrandTheme
  hook?: string
  tryOnStyle?: ResolvedContentTheme['tryOnStyle']
  stage: 'draft_rendering' | 'gate1_ready' | 'pro_rendering' | 'gate2_ready' | 'published'
  qualityPass: RenderQuality
  page: 'lifestyle' | 'onlineshop'
  conversationId?: string | null
  caption?: string
  captionFooter?: string
  gate2Id?: string
  autonomousSlot?: number
  themeLabel?: string
}

export type ContentGate1Keyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

/** @deprecated use resolveTheme from theme.ts */
export async function resolveContentTheme(): Promise<{ theme: BrandTheme; hook: string }> {
  const t = await resolveTheme()
  return { theme: t.theme, hook: t.hook }
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
  tryOnStyle: ResolvedContentTheme['tryOnStyle']
  conversationId?: string | null
  seedNote?: string
}): Promise<string[]> {
  const specs = await generateProductVariants({
    product: args.product,
    variants: args.variants,
    quality: args.quality,
    style: args.tryOnStyle,
    seedNote: args.seedNote,
  })

  const actionIds: string[] = []
  for (const spec of specs) {
    const action = await db.agentPendingAction.create({
      data: {
        conversationId: args.conversationId ?? null,
        type: 'image_gen',
        payload: {
          prompt: spec.prompt,
          quality: spec.workerQuality,
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

export async function countPendingContentApprovals(): Promise<number> {
  return db.agentPendingAction.count({
    where: {
      type: { in: ['content_gate1', 'content_gate2'] },
      status: 'pending',
    },
  })
}

export async function startContentPipeline(opts: {
  productCode?: string
  conversationId?: string | null
  page?: 'lifestyle' | 'onlineshop'
  variants?: ContentVariant[]
  resolvedTheme?: ResolvedContentTheme
  autonomousSlot?: number
}): Promise<{ gate1Id: string; pipelineId: string; productCode: string; variants: ContentVariant[] }> {
  const product = await loadProductAsset(opts.productCode)
  if (!product) throw new Error('product_not_found')

  const config = await getContentEngineConfig()
  const variants = opts.variants?.length
    ? opts.variants
    : variantsForProduct(product.familyMatch, config.variants)
  const resolved = opts.resolvedTheme ?? (await resolveTheme())
  const { theme, hook, tryOnStyle, label: themeLabel } = resolved
  const page = opts.page ?? 'lifestyle'
  const captionResult = await generateCaption(product, { theme, page, hook })
  const pipelineId = randomUUID()

  const payload: ContentPipelinePayload = {
    pipelineId,
    productCode: product.productCode,
    variants: variants.map((key) => ({
      key,
      rawImagePath: null,
      framedImagePath: null,
      renderActionId: null,
      keep: true,
    })),
    theme,
    hook: captionResult.hook,
    tryOnStyle,
    caption: captionResult.caption,
    captionFooter: captionResult.footer,
    stage: 'draft_rendering',
    qualityPass: 'draft',
    page,
    conversationId: opts.conversationId ?? null,
    autonomousSlot: opts.autonomousSlot,
    themeLabel,
  }

  const gate1 = await db.agentPendingAction.create({
    data: {
      conversationId: opts.conversationId ?? null,
      type: 'content_gate1',
      payload,
      summary:
        `📸 কন্টেন্ট পোস্ট — Gate 1 (ছবি)\n` +
        `প্রোডাক্ট: ${product.productCode}\n` +
        `থিম: ${themeLabel} | ${captionResult.hook}\n` +
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
    tryOnStyle,
    conversationId: opts.conversationId,
  })

  for (let i = 0; i < variants.length; i++) {
    updateVariantRenderId(payload, variants[i], actionIds[i])
  }
  await db.agentPendingAction.update({
    where: { id: gate1.id },
    data: { payload },
  })

  return { gate1Id: gate1.id, pipelineId, productCode: product.productCode, variants }
}

export function buildContentGate1Keyboard(
  gate1Id: string,
  payload: ContentPipelinePayload,
): ContentGate1Keyboard {
  const rows: ContentGate1Keyboard['inline_keyboard'] = []
  for (const v of payload.variants) {
    if (!v.framedImagePath) continue
    const keepIcon = v.keep ? '✅' : '⬜'
    rows.push([
      { text: `${keepIcon} ${variantLabel(v.key)}`, callback_data: `content_keep:${gate1Id}:${v.key}` },
      { text: `🔄 ${variantLabel(v.key)}`, callback_data: `content_regen:${gate1Id}:${v.key}` },
    ])
  }
  const keptCount = payload.variants.filter((v) => v.keep && v.framedImagePath).length
  rows.push([
    {
      text: `✅ Approve (${keptCount}) → PRO`,
      callback_data: `approve:${gate1Id}`,
    },
    { text: '❌ বাতিল', callback_data: `reject:${gate1Id}` },
  ])
  return { inline_keyboard: rows }
}

async function buildGate1Summary(productCode: string, payload: ContentPipelinePayload): Promise<string> {
  const lines = [
    `📸 কন্টেন্ট পোস্ট — Gate 1 (ছবি অনুমোদন)`,
    `প্রোডাক্ট: ${productCode}`,
    `থিম: ${payload.theme} | ${payload.hook ?? ''}`,
    '',
    'ভ্যারিয়েন্ট (✅=রাখবেন, ⬜=বাদ):',
  ]
  for (const v of payload.variants) {
    const path = v.framedImagePath ?? v.rawImagePath
    const keepTag = v.framedImagePath ? (v.keep ? '✅' : '⬜') : '⏳'
    if (path) {
      try {
        const url = await agentStorageSignedUrl(path, 3600)
        lines.push(`• ${keepTag} ${variantLabel(v.key)}: ![${v.key}](${url})`)
      } catch (err) {
        console.warn('[pipeline] signed URL failed for variant:', err instanceof Error ? err.message : err)
        lines.push(`• ${keepTag} ${variantLabel(v.key)}: ${path}`)
      }
    } else if (v.renderActionId) {
      lines.push(`• ⏳ ${variantLabel(v.key)}: রেন্ডার হচ্ছে…`)
    }
  }
  const kept = payload.variants.filter((v) => v.keep && v.framedImagePath).length
  lines.push(
    '',
    `${kept}টি ভ্যারিয়েন্ট PRO-তে যাবে। দুর্বল ছবি 🔄 Regenerate — ভালোগুলো ✅ Keep রাখুন।`,
    'সব ঠিক থাকলে Approve করুন।',
  )
  return lines.join('\n')
}

function allDraftVariantsReady(payload: ContentPipelinePayload): boolean {
  return payload.variants.every((v) => Boolean(v.framedImagePath))
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
    mode: 'model_overlay',
    productCode: payload.productCode,
    hook: payload.hook ?? 'নতুন কালেকশন',
    theme: payload.theme,
    footer: payload.qualityPass === 'pro',
  })
  variant.keep = true

  if (payload.qualityPass === 'draft') {
    const ready = allDraftVariantsReady(payload)
    if (ready) {
      payload.stage = 'gate1_ready'
      const summary = await buildGate1Summary(payload.productCode, payload)
      await db.agentPendingAction.update({
        where: { id: gate1.id },
        data: { payload, summary },
      })
      await sendOwnerApprovalCard({
        summary,
        reply_markup: buildContentGate1Keyboard(gate1.id, payload),
      })
      return
    }

    if (payload.stage === 'gate1_ready') {
      const summary = await buildGate1Summary(payload.productCode, payload)
      await db.agentPendingAction.update({
        where: { id: gate1.id },
        data: { payload, summary },
      })
      await sendOwnerApprovalCard({
        summary: `🔄 ${variantLabel(cp.variant)} রিজেনারেট সম্পন্ন\n\n${summary}`,
        reply_markup: buildContentGate1Keyboard(gate1.id, payload),
      })
      return
    }

    await db.agentPendingAction.update({ where: { id: gate1.id }, data: { payload } })
    return
  }

  const allProDone = payload.variants.every((v) => v.framedImagePath)
  if (!allProDone) {
    await db.agentPendingAction.update({ where: { id: gate1.id }, data: { payload } })
    return
  }

  payload.stage = 'gate2_ready'
  const captionText = payload.caption ?? `${payload.productCode} — Alma Lifestyle`

  const imageLines: string[] = []
  for (const v of payload.variants) {
    if (!v.framedImagePath) continue
    try {
      const url = await agentStorageSignedUrl(v.framedImagePath, 3600)
      imageLines.push(`![${v.key}](${url})`)
    } catch (err) {
      console.warn('[pipeline] gate2 signed URL failed:', err instanceof Error ? err.message : err)
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
        message: captionText,
        hook: payload.hook,
        imagePaths: payload.variants.map((v) => v.framedImagePath).filter(Boolean),
        primaryImagePath: primaryImage,
        conversationId: payload.conversationId,
      },
      summary:
        `📣 কন্টেন্ট পোস্ট — Gate 2 (ফাইনাল)\n` +
        `প্রোডাক্ট: ${payload.productCode}\n` +
        `ক্যাপশন:\n${captionText.slice(0, 400)}`,
      status: 'pending',
    },
  })

  payload.gate2Id = gate2.id
  await db.agentPendingAction.update({
    where: { id: gate1.id },
    data: { payload, status: 'executed', resolvedAt: new Date() },
  })

  await sendOwnerApprovalCard({
    summary:
      `📣 কন্টেন্ট Gate 2 প্রস্তুত — ${payload.productCode}\n` +
      `${imageLines.join('\n')}\n\n${captionText.slice(0, 500)}`,
    pendingActionId: gate2.id,
    approveLabel: '✅ Publish',
    rejectLabel: '❌ বাতিল',
  })
}

export async function toggleGate1VariantKeep(
  gate1Id: string,
  variantKey: ContentVariant,
): Promise<{ keep: boolean; summary: string; keyboard: ContentGate1Keyboard }> {
  const gate1 = await db.agentPendingAction.findUnique({ where: { id: gate1Id } })
  if (!gate1 || gate1.type !== 'content_gate1') throw new Error('invalid_gate1')
  const payload = gate1.payload as ContentPipelinePayload
  if (payload.stage !== 'gate1_ready') throw new Error('gate1_not_ready')

  const v = payload.variants.find((x) => x.key === variantKey)
  if (!v?.framedImagePath) throw new Error('variant_not_ready')

  v.keep = !v.keep
  const summary = await buildGate1Summary(payload.productCode, payload)
  await db.agentPendingAction.update({
    where: { id: gate1Id },
    data: { payload, summary },
  })

  if (v.keep && v.framedImagePath) {
    const product = await loadProductAsset(payload.productCode).catch(() => null)
    const { captureTasteSignalAsync } = await import('@/agent/lib/taste/capture')
    captureTasteSignalAsync({
      verdict: 'keep',
      imagePath: v.framedImagePath,
      productCode: payload.productCode,
      productType: product?.category ?? null,
      source: `content_gate1:${variantKey}`,
    })
  }

  return { keep: v.keep, summary, keyboard: buildContentGate1Keyboard(gate1Id, payload) }
}

export async function regenerateGate1Variant(
  gate1Id: string,
  variantKey: ContentVariant,
): Promise<{ queued: boolean; summary: string }> {
  const gate1 = await db.agentPendingAction.findUnique({ where: { id: gate1Id } })
  if (!gate1 || gate1.type !== 'content_gate1') throw new Error('invalid_gate1')
  const payload = gate1.payload as ContentPipelinePayload
  if (payload.stage !== 'gate1_ready') throw new Error('gate1_not_ready')

  const product = await loadProductAsset(payload.productCode)
  if (!product) throw new Error('product_not_found')

  const v = payload.variants.find((x) => x.key === variantKey)
  if (!v) throw new Error('variant_not_found')

  if (v.framedImagePath) {
    const { captureTasteSignalAsync } = await import('@/agent/lib/taste/capture')
    captureTasteSignalAsync({
      verdict: 'reject',
      imagePath: v.framedImagePath,
      productCode: payload.productCode,
      productType: product.category ?? null,
      source: `content_gate1_regen:${variantKey}`,
    })
  }

  v.rawImagePath = null
  v.framedImagePath = null
  v.renderActionId = null
  v.keep = true

  const [actionId] = await queueVariantRenders({
    product,
    variants: [variantKey],
    quality: 'draft',
    pipelineId: payload.pipelineId,
    gate1Id,
    theme: payload.theme,
    tryOnStyle: payload.tryOnStyle ?? 'studio',
    conversationId: payload.conversationId,
    seedNote: `regenerate ${variantKey}`,
  })
  v.renderActionId = actionId

  const summary = await buildGate1Summary(payload.productCode, payload)
  await db.agentPendingAction.update({
    where: { id: gate1Id },
    data: { payload, summary },
  })

  return { queued: true, summary }
}

export async function advanceToProRenders(gate1Id: string): Promise<{ queued: boolean; message: string }> {
  const gate1 = await db.agentPendingAction.findUnique({ where: { id: gate1Id } })
  if (!gate1 || gate1.type !== 'content_gate1') throw new Error('invalid_gate1')
  const payload = gate1.payload as ContentPipelinePayload
  if (payload.stage !== 'gate1_ready') throw new Error('gate1_not_ready')

  const kept = payload.variants.filter((v) => v.keep && v.framedImagePath)
  if (!kept.length) throw new Error('no_variants_kept')

  const product = await loadProductAsset(payload.productCode)
  if (!product) throw new Error('product_not_found')

  payload.stage = 'pro_rendering'
  payload.qualityPass = 'pro'
  payload.variants = kept.map((v) => ({
    ...v,
    rawImagePath: null,
    framedImagePath: null,
    renderActionId: null,
  }))

  const variants = payload.variants.map((v) => v.key)
  const actionIds = await queueVariantRenders({
    product,
    variants,
    quality: 'pro',
    pipelineId: payload.pipelineId,
    gate1Id,
    theme: payload.theme,
    tryOnStyle: payload.tryOnStyle ?? 'studio',
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
      summary: `📸 Gate 1 অনুমোদিত — PRO রেন্ডার হচ্ছে (${payload.productCode}, ${variants.length}টি)`,
    },
  })

  return {
    queued: true,
    message: `Gate 1 approved — ${variants.length} variant(s) queued for PRO. Gate 2 follows when renders finish.`,
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

/** Alias for agent tool naming in phase docs. */
export const runContentPost = startContentPipeline

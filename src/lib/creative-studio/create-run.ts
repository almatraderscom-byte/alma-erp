import { prisma } from '@/lib/prisma'
import { isFashnConfigured } from '@/lib/fashn/client'
import { buildVideoBrief, estimateReelCostUsd } from '@/lib/content-engine/video-brief'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import { STUDIO_MODES } from '@/lib/creative-studio/constants'
import { queueTryOnBatch, type ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import { getDefaultModel, getModelByRole } from '@/lib/tryon/model-library'
import {
  startFamilyChain,
  startSingleRescueChain,
  FamilyChainModelError,
  type FamilyChainVariant,
} from '@/lib/tryon/family-chain'
import { pickScene } from '@/lib/tryon/scene-pool'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CreativeStudioRunInput = {
  mode: StudioModeId
  provider?: StudioProvider
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
  secondSourceImagePath?: string
  faceReferencePath?: string
  modelId?: string
  familyPreset?: FamilyPresetId
  prompt?: string
  backgroundPrompt?: string
  aspectRatio?: string
  resolution?: FashnResolution
  generationMode?: FashnGenerationMode
  numImages?: number
  /** Video only */
  durationSec?: number
  vibe?: 'premium' | 'festival' | 'offer' | 'lifestyle'
}

export type CreativeStudioJobRef = {
  pendingActionId: string
  label: string
  type: 'image_gen' | 'video_gen'
}

function resolveProvider(
  requested: StudioProvider | undefined,
  mode: StudioModeId,
  familyPreset?: FamilyPresetId,
): StudioProvider {
  if (mode === 'image_to_video') return 'gemini'
  // Multi-person family presets require Gemini compositing; FASHN tryon-max is single-person only.
  if (familyPreset && familyPreset !== 'single') return 'gemini'
  if (requested === 'gemini') return 'gemini'
  if (requested === 'fashn' && isFashnConfigured()) return 'fashn'
  if (isFashnConfigured() && STUDIO_MODES.find((m) => m.id === mode)?.fashnModel) return 'fashn'
  return 'gemini'
}

function familyPrompt(preset: FamilyPresetId): string {
  const map: Record<FamilyPresetId, string> = {
    single: '',
    father_son: 'Bangladeshi father and son (age 5-12) wearing matching outfits from product, one cohesive family photoshoot.',
    mother_son: 'Bangladeshi mother and son (age 5-12) wearing matching outfits, family fashion shoot.',
    mother_daughter: 'Bangladeshi mother and daughter (age 5-10) wearing matching outfits, family fashion shoot.',
    full_family: 'Full Bangladeshi family father mother son daughter in matching coordinated outfits, one scene.',
  }
  return map[preset] ?? ''
}

async function mergeApprovedPayload(
  pendingActionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const existing = await db.agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: { payload: true },
  })
  const prev = (existing?.payload ?? {}) as Record<string, unknown>
  await db.agentPendingAction.update({
    where: { id: pendingActionId },
    data: {
      status: 'approved',
      payload: { ...prev, ...patch, creativeStudio: true, skipTelegramCard: true },
    },
  })
}

async function createApprovedAction(data: {
  type: 'image_gen' | 'video_gen'
  payload: Record<string, unknown>
  summary: string
  costEstimate: number
}): Promise<string> {
  const row = await db.agentPendingAction.create({
    data: {
      conversationId: null,
      type: data.type,
      payload: { ...data.payload, creativeStudio: true, skipTelegramCard: true },
      summary: data.summary,
      costEstimate: data.costEstimate,
      status: 'approved',
    },
  })
  return row.id as string
}

export async function runCreativeStudio(input: CreativeStudioRunInput): Promise<{
  jobs: CreativeStudioJobRef[]
  provider: StudioProvider
  fashnReady: boolean
}> {
  const modeDef = STUDIO_MODES.find((m) => m.id === input.mode)
  if (!modeDef) throw new Error('invalid_mode')

  const provider = resolveProvider(input.provider, input.mode, input.familyPreset)
  const fashnReady = isFashnConfigured()
  const jobs: CreativeStudioJobRef[] = []

  // FAMILY MERGE: combine two already-generated images (e.g. father+son and mother+daughter)
  // into ONE four-person family photoshoot. Worker composites both reference images via Gemini.
  if (input.familyPreset === 'full_family' && input.sourceImagePath && input.secondSourceImagePath) {
    const mergePrompt = [
      'Combine the people from BOTH reference images into ONE cohesive Bangladeshi family photoshoot.',
      'Reference image 1 shows some family members; reference image 2 shows the others.',
      'Place ALL of them together in a single natural scene — full family (father, mother, son, daughter)',
      'standing/posed together as one group. Preserve each person\'s face, outfit and identity exactly',
      'as shown in their source image. One consistent lighting, background and photographic style.',
      input.prompt,
      input.backgroundPrompt,
    ].filter(Boolean).join(' ')

    const id = await createApprovedAction({
      type: 'image_gen',
      payload: {
        // NOTE: no provider:'fashn' → worker uses the Gemini multi-image path
        prompt: mergePrompt,
        quality: input.generationMode === 'quality' ? 'pro' : 'standard',
        referenceImageId: input.sourceImagePath,
        secondReferenceImageId: input.secondSourceImagePath,
        aspectRatio: input.aspectRatio ?? '4:5',
        imageSize: input.resolution ? input.resolution.toUpperCase() : '2K',
        creativeStudio: true,
        studioMode: input.mode,
        familyPreset: 'full_family',
        familyMerge: true,
      },
      summary: '🎨 Studio Family Merge (Gemini)',
      costEstimate: 0.25,
    })
    jobs.push({ pendingActionId: id, label: 'Family Merge', type: 'image_gen' })
    return { jobs, provider: 'gemini', fashnReady: isFashnConfigured() }
  }

  // FAMILY ACCURACY CHAIN — the assembly line (adult FASHN shot → child garment →
  // child FASHN shot → Gemini merge). Replaces the one-shot Gemini invention whenever
  // FASHN is configured; each person's garment is rendered by the accurate engine and
  // the saved child models keep the same face on every run. Missing role models throw
  // FamilyChainModelError so the owner gets a clear "add the model" message instead of
  // a silent adult-for-child substitution.
  if (
    fashnReady
    && input.productImagePath
    && input.familyPreset
    && input.familyPreset !== 'single'
    && (input.mode === 'try_on' || input.mode === 'product_to_model')
  ) {
    const chain = await startFamilyChain({
      variant: input.familyPreset as FamilyChainVariant,
      productImagePath: input.productImagePath,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      generationMode: input.generationMode,
      extraPrompt: [input.prompt, input.backgroundPrompt].filter(Boolean).join('. ') || undefined,
      conversationId: null,
    })
    for (const j of chain.jobs) jobs.push(j)
    return { jobs, provider: 'fashn', fashnReady }
  }

  const extraPrompt = [input.prompt, input.backgroundPrompt, input.familyPreset ? familyPrompt(input.familyPreset) : '']
    .filter(Boolean)
    .join('. ')

  if (input.mode === 'image_to_video') {
    const imagePath = input.sourceImagePath ?? input.productImagePath ?? input.modelImagePath
    if (!imagePath) throw new Error('source_image_required')

    const vibe = input.vibe ?? 'premium'
    const durationSec = Math.min(Math.max(Number(input.durationSec ?? 6), 4), 8)
    const aspect = input.aspectRatio === '16:9' ? '16:9' : '9:16'
    const { prompt } = buildVideoBrief(
      {
        productCode: 'studio-reel',
        name: null,
        category: null,
        fabric: null,
        imagePath,
        familyMatch: false,
      },
      { vibe, aspect: aspect as '9:16' | '16:9', durationSec },
    )

    const id = await createApprovedAction({
      type: 'video_gen',
      payload: {
        prompt,
        referenceImageId: imagePath,
        durationSec,
        aspect,
        creativeStudio: true,
        studioMode: input.mode,
        provider: 'gemini',
      },
      summary: `🎬 Creative Studio Reel (${durationSec}s ${aspect})`,
      costEstimate: estimateReelCostUsd(durationSec),
    })
    jobs.push({ pendingActionId: id, label: 'Product Reel (Veo 3.1)', type: 'video_gen' })
    return { jobs, provider: 'gemini', fashnReady }
  }

  // Family batch via Gemini try-on batch (works without FASHN)
  if (
    provider === 'gemini'
    && input.productImagePath
    && input.familyPreset
    && input.familyPreset !== 'single'
    && (input.mode === 'try_on' || input.mode === 'product_to_model')
  ) {
    const variants = [input.familyPreset] as ChatTryOnVariant[]
    const batch = await queueTryOnBatch({
      productImagePath: input.productImagePath,
      modelId: input.modelId,
      variants,
      extra: extraPrompt,
      conversationId: null,
    })
    for (const item of batch.items) {
      await mergeApprovedPayload(item.pendingActionId, {
        studioMode: input.mode,
        provider: 'gemini',
        familyPreset: input.familyPreset,
      })
      jobs.push({ pendingActionId: item.pendingActionId, label: item.label, type: 'image_gen' })
    }
    return { jobs, provider: 'gemini', fashnReady }
  }

  if (provider === 'fashn' && modeDef.fashnModel) {
    if (!input.productImagePath && modeDef.needsProduct) throw new Error('product_image_required')
    if (!input.modelImagePath && modeDef.needsModel) throw new Error('model_image_required')
    if (!input.sourceImagePath && modeDef.needsSource) throw new Error('source_image_required')

    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)

    // Try-on with a model photo: run the 2-step chain (FASHN garment accuracy →
    // Bangladeshi background swap). Each image picks its own random scene + pose,
    // so no two outputs share the same look — a raw FASHN render would otherwise
    // reuse the model photo's background every single time.
    const tryOnModelPath = input.modelImagePath ?? input.sourceImagePath
    if (input.mode === 'try_on' && input.productImagePath && tryOnModelPath) {
      for (let i = 0; i < count; i++) {
        const job = await startSingleRescueChain({
          productImagePath: input.productImagePath,
          modelImagePath: tryOnModelPath,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          generationMode: input.generationMode,
          extraPrompt: extraPrompt || undefined,
          conversationId: null,
        })
        jobs.push({ pendingActionId: job.pendingActionId, label: modeDef.label, type: 'image_gen' })
      }
      return { jobs, provider: 'fashn', fashnReady }
    }

    const fashnInputs: Record<string, string> = {}
    if (input.productImagePath) fashnInputs.product_image = input.productImagePath
    if (input.modelImagePath) fashnInputs.model_image = input.modelImagePath
    if (input.sourceImagePath) fashnInputs.model_image = input.sourceImagePath
    if (input.faceReferencePath) fashnInputs.face_reference = input.faceReferencePath

    // product_to_model has no model photo to inherit a background from — vary the
    // look per image with a random pose + fully-Bangladeshi scene in the prompt.
    // Owner-driven modes (edit / model_swap / face_to_model) keep the prompt as-is.
    const injectScene = input.mode === 'product_to_model'
    for (let i = 0; i < count; i++) {
      const picked = injectScene ? pickScene() : null
      const sceneLine = picked ? `Pose: ${picked.adultPose}. ${picked.scene.prompt}` : ''
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'fashn',
          fashnModel: modeDef.fashnModel,
          fashnInputs,
          fashnOptions: {
            prompt: [extraPrompt, sceneLine].filter(Boolean).join(' ') || undefined,
            resolution: input.resolution ?? '2k',
            generationMode: input.generationMode ?? 'balanced',
            numImages: 1,
            outputFormat: 'png',
          },
          aspectRatio: input.aspectRatio ?? '4:5',
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: input.familyPreset,
          productImagePath: input.productImagePath,
          modelImagePath: input.modelImagePath,
        },
        summary: `🎨 Studio ${modeDef.label}${count > 1 ? ` #${i + 1}` : ''} (FASHN)`,
        costEstimate: 0.25,
      })
      jobs.push({ pendingActionId: id, label: modeDef.label, type: 'image_gen' })
    }
    return { jobs, provider: 'fashn', fashnReady }
  }

  // Gemini fallback single/batch
  if (!input.productImagePath) throw new Error('product_image_required')

  if (input.familyPreset && input.familyPreset !== 'single') {
    const batch = await queueTryOnBatch({
      productImagePath: input.productImagePath,
      modelId: input.modelId,
      variants: [input.familyPreset],
      extra: extraPrompt,
      conversationId: null,
    })
    for (const item of batch.items) {
      await mergeApprovedPayload(item.pendingActionId, {
        studioMode: input.mode,
        provider: 'gemini',
        familyPreset: input.familyPreset,
      })
      jobs.push({ pendingActionId: item.pendingActionId, label: item.label, type: 'image_gen' })
    }
    return { jobs, provider: 'gemini', fashnReady }
  }

  const batch = await queueTryOnBatch({
    productImagePath: input.productImagePath,
    modelId: input.modelId,
    variants: ['single'],
    extra: extraPrompt,
    conversationId: null,
  })
  await mergeApprovedPayload(batch.items[0].pendingActionId, {
    studioMode: input.mode,
    provider: 'gemini',
  })
  jobs.push({
    pendingActionId: batch.items[0].pendingActionId,
    label: modeDef.label,
    type: 'image_gen',
  })
  return { jobs, provider: 'gemini', fashnReady }
}

export type AutoStudioResult = {
  jobs: CreativeStudioJobRef[]
  provider: StudioProvider
  modelName: string
  variants: ChatTryOnVariant[]
  reelQueued: boolean
}

/**
 * One-tap Auto: owner uploads only a product image. We auto-pick the default
 * brand model, auto-classify the garment + auto-write the prompt (inside
 * queueTryOnBatch), and queue a curated on-model set. Family variants are
 * added only when the required role models exist, so it never fails for a
 * missing model. No prompt / no manual settings required.
 *
 * Phase 3 (best realism): when FASHN_API_KEY is set, the solo on-model shot is
 * rendered through FASHN tryon-max (purpose-built virtual try-on, best realism)
 * instead of Gemini. Family variants stay on Gemini (multi-person). Without the
 * key everything gracefully falls back to Gemini.
 *
 * Phase 4 (video): includeReel queues a short product reel (Veo 3.1) from the
 * same product image — owner-initiated, so spend stays under the owner's tap.
 */
export async function runAutoStudio(input: {
  productImagePath: string
  includeFamily?: boolean
  includeReel?: boolean
}): Promise<AutoStudioResult> {
  const productImagePath = input.productImagePath?.trim()
  if (!productImagePath) throw new Error('product_image_required')

  const defaultModel = await getDefaultModel()
  if (!defaultModel) throw new Error('no_default_model')

  const useFashn = isFashnConfigured()
  const jobs: CreativeStudioJobRef[] = []
  /** variants rendered via the legacy Gemini batch (no-FASHN fallback) */
  const variants: ChatTryOnVariant[] = []
  /** variants rendered via the accuracy chain (reported to the UI alongside `variants`) */
  const chainedVariants: ChatTryOnVariant[] = []

  // Solo on-model shot: FASHN accuracy + a Bangladeshi background swap (2-step
  // chain) so every Auto run comes back with a different pose/scene. Falls back
  // to the Gemini try-on batch without a FASHN key.
  if (useFashn) {
    const job = await startSingleRescueChain({
      productImagePath,
      modelImagePath: defaultModel.imagePath,
      generationMode: 'quality',
      conversationId: null,
    })
    jobs.push({ pendingActionId: job.pendingActionId, label: 'On-model (best realism)', type: 'image_gen' })
  } else {
    variants.push('single')
  }

  if (input.includeFamily) {
    const [father, mother, son, daughter] = await Promise.all([
      getModelByRole('father'),
      getModelByRole('mother'),
      getModelByRole('son'),
      getModelByRole('daughter'),
    ])
    const pairs: FamilyChainVariant[] = []
    if (father && son) pairs.push('father_son')
    if (mother && son) pairs.push('mother_son')
    if (mother && daughter) pairs.push('mother_daughter')

    if (useFashn) {
      // Accuracy chain per pair — saved child models keep the same face every run.
      for (const v of pairs) {
        try {
          const chain = await startFamilyChain({
            variant: v,
            productImagePath,
            generationMode: 'quality',
            conversationId: null,
          })
          for (const j of chain.jobs) jobs.push(j)
          chainedVariants.push(v as ChatTryOnVariant)
        } catch (err) {
          if (!(err instanceof FamilyChainModelError)) throw err
        }
      }
    } else {
      for (const v of pairs) variants.push(v as ChatTryOnVariant)
    }
  }

  if (variants.length > 0) {
    const batch = await queueTryOnBatch({
      productImagePath,
      modelId: defaultModel.id,
      variants,
      conversationId: null,
    })
    for (const item of batch.items) {
      await mergeApprovedPayload(item.pendingActionId, {
        studioMode: 'product_to_model',
        provider: 'gemini',
        auto: true,
        familyPreset: item.variant,
      })
      jobs.push({ pendingActionId: item.pendingActionId, label: item.label, type: 'image_gen' })
    }
  }

  let reelQueued = false
  if (input.includeReel) {
    const durationSec = 6
    const aspect = '9:16' as const
    const { prompt } = buildVideoBrief(
      { productCode: 'studio-reel', name: null, category: null, fabric: null, imagePath: productImagePath, familyMatch: false },
      { vibe: 'premium', aspect, durationSec },
    )
    const reelId = await createApprovedAction({
      type: 'video_gen',
      payload: {
        prompt,
        referenceImageId: productImagePath,
        durationSec,
        aspect,
        studioMode: 'image_to_video',
        provider: 'gemini',
        auto: true,
      },
      summary: `🎬 Auto Studio Reel (${durationSec}s ${aspect})`,
      costEstimate: estimateReelCostUsd(durationSec),
    })
    jobs.push({ pendingActionId: reelId, label: 'Product Reel (Veo 3.1)', type: 'video_gen' })
    reelQueued = true
  }

  return {
    jobs,
    provider: useFashn ? 'fashn' : 'gemini',
    modelName: defaultModel.name,
    variants: [...chainedVariants, ...variants],
    reelQueued,
  }
}

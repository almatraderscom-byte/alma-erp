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
import {
  getOrClassifyGarment,
  mapGarmentToVtonClothType,
  mapGarmentToFashnCategory,
} from '@/lib/tryon/art-director'
import {
  CS_FAL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  getEngine,
  isFalVtonEngine,
  isVtonClothType,
  type StudioEngineId,
  type VtonClothType,
} from '@/lib/creative-studio/provider-registry'
import { readKv } from '@/lib/creative-studio/taste'
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
  /** CS6 — single Try-On engine choice (fal_fashn_v16 / fal_idm_vton route to Fal; fashn/gemini keep legacy paths) */
  vtonEngine?: StudioEngineId
  /** CS6 — owner override for cat-vton garment placement when auto classification is uncertain */
  clothType?: VtonClothType | 'auto'
  /** CS6 — optional fixed seed for reproducible benchmark runs */
  seed?: number
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
    father_daughter: 'Bangladeshi father and daughter (age 5-10) wearing matching outfits, family fashion shoot.',
    couple: 'Bangladeshi husband and wife wearing matching couple outfits, modest natural couple pose, fashion shoot.',
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
  /** engine that will actually run — legacy 'fashn'/'gemini' or a CS6 fal VTON engine id */
  provider: StudioProvider | StudioEngineId
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

    // V4: 16s+ reels = a multi-clip Veo chain (2–3 × 8s, per-clip scene-pool
    // variety, crossfade-stitched by the worker). Owner-initiated only; the UI
    // shows the cost before this ever runs.
    if (Number(input.durationSec) >= 16) {
      const { startVeoReelChain } = await import('@/lib/creative-studio/veo-chain')
      const chain = await startVeoReelChain({
        productImagePath: imagePath,
        totalClips: Number(input.durationSec) >= 24 ? 3 : 2,
        aspect: input.aspectRatio === '16:9' ? '16:9' : '9:16',
        vibe,
      })
      jobs.push({ pendingActionId: chain.pendingActionId, label: 'লম্বা রিল (Veo multi-clip)', type: 'video_gen' })
      return { jobs, provider: 'gemini', fashnReady }
    }
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

  // ── CS6: Fal-backed single-person VTON (owner-selected engine) ─────────────
  // Single Try-On ONLY — multi-person family presets never reach here (they're
  // handled by the accuracy chain above), and the UI hides these engines for
  // family/swap/face/edit/video. The worker runs the durable Fal queue client.
  if (
    isFalVtonEngine(input.vtonEngine)
    && input.mode === 'try_on'
    && (!input.familyPreset || input.familyPreset === 'single')
  ) {
    if (!input.productImagePath) throw new Error('product_image_required')
    const vtonModelPath = input.modelImagePath ?? input.sourceImagePath
    if (!vtonModelPath) throw new Error('model_image_required')
    if (!process.env.FAL_KEY?.trim()) throw new Error('fal_not_configured')

    const engine = getEngine(input.vtonEngine)
    // Owner flag gates: fal master switch for the commercial engine, the
    // dedicated experimental switch for IDM.
    if (input.vtonEngine === 'fal_fashn_v16' && (await readKv(CS_FAL_ENABLED_KEY)) !== '1') {
      throw new Error('fal_engine_disabled')
    }
    if (input.vtonEngine === 'fal_idm_vton' && (await readKv(CS_IDM_VTON_ENABLED_KEY)) !== '1') {
      throw new Error('idm_vton_disabled')
    }

    // Garment placement: honour the owner's manual override; otherwise classify
    // (cached per product) and map via the owner-locked table.
    const attrs = await getOrClassifyGarment(input.productImagePath)
    const auto = mapGarmentToVtonClothType(attrs)
    const clothType: VtonClothType = isVtonClothType(input.clothType) ? input.clothType : auto.clothType

    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)
    const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed as number) : undefined
    for (let i = 0; i < count; i++) {
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'fal',
          falEngine: input.vtonEngine,
          falEndpointId: engine.falEndpointId,
          productImagePath: input.productImagePath,
          modelImagePath: vtonModelPath,
          clothType,
          clothTypeSource: isVtonClothType(input.clothType) ? 'owner' : 'auto',
          clothTypeUncertain: auto.uncertain,
          fashnCategory: mapGarmentToFashnCategory(attrs),
          // CS6 defaults (roadmap): 30 steps, guidance 2.5, fixed seed when supplied.
          numInferenceSteps: 30,
          guidanceScale: 2.5,
          ...(seed !== undefined ? { seed: seed + i } : {}),
          prompt: extraPrompt || undefined,
          generationMode: input.generationMode ?? 'balanced',
          aspectRatio: input.aspectRatio ?? '4:5',
          creativeStudio: true,
          studioMode: input.mode,
          familyPreset: 'single',
        },
        summary: `🎨 Studio Try-On${count > 1 ? ` #${i + 1}` : ''} (${engine.label})`,
        costEstimate: input.vtonEngine === 'fal_fashn_v16' ? 0.075 : 0.1,
      })
      jobs.push({ pendingActionId: id, label: `Try-On · ${engine.label}`, type: 'image_gen' })
    }
    return { jobs, provider: input.vtonEngine, fashnReady }
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

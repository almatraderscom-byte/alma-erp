import { prisma } from '@/lib/prisma'
import { isFashnConfigured } from '@/lib/fashn/client'
import { buildVideoBrief, estimateReelCostUsd } from '@/lib/content-engine/video-brief'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import { STUDIO_MODES } from '@/lib/creative-studio/constants'
import { queueTryOnBatch, type ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type CreativeStudioRunInput = {
  mode: StudioModeId
  provider?: StudioProvider
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
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

function resolveProvider(requested: StudioProvider | undefined, mode: StudioModeId): StudioProvider {
  if (mode === 'image_to_video') return 'gemini'
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

  const provider = resolveProvider(input.provider, input.mode)
  const fashnReady = isFashnConfigured()
  const jobs: CreativeStudioJobRef[] = []

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

    const fashnInputs: Record<string, string> = {}
    if (input.productImagePath) fashnInputs.product_image = input.productImagePath
    if (input.modelImagePath) fashnInputs.model_image = input.modelImagePath
    if (input.sourceImagePath) fashnInputs.model_image = input.sourceImagePath
    if (input.faceReferencePath) fashnInputs.face_reference = input.faceReferencePath

    const count = Math.min(Math.max(input.numImages ?? 1, 1), 4)
    for (let i = 0; i < count; i++) {
      const id = await createApprovedAction({
        type: 'image_gen',
        payload: {
          provider: 'fashn',
          fashnModel: modeDef.fashnModel,
          fashnInputs,
          fashnOptions: {
            prompt: extraPrompt || undefined,
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

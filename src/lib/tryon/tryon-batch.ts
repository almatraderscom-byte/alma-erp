import { prisma } from '@/lib/prisma'
import {
  buildFamilyVariantExtra,
  buildTryOnPrompt,
  getModelByRole,
  getOrClassifyGarment,
  normalizeGarmentType,
  resolveModel,
  type ModelRole,
  type SavedModel,
  type TryOnPose,
  type TryOnStyle,
} from '@/lib/tryon/model-library'
import type { GarmentType } from '@/lib/tryon/art-director'

export type ChatTryOnVariant =
  | 'single'
  | 'father_son'
  | 'mother_son'
  | 'mother_daughter'
  | 'full_family'

export const CHAT_TRYON_VARIANTS: ChatTryOnVariant[] = [
  'single',
  'father_son',
  'mother_son',
  'mother_daughter',
  'full_family',
]

const VARIANT_LABELS: Record<ChatTryOnVariant, string> = {
  single: 'সিঙ্গেল মডেল',
  father_son: 'বাবা + ছেলে',
  mother_son: 'মা + ছেলে',
  mother_daughter: 'মা + মেয়ে',
  full_family: 'পুরো ফ্যামিলি',
}

function primaryRoleForVariant(variant: ChatTryOnVariant): ModelRole {
  if (variant === 'single') return 'single'
  if (variant === 'mother_son' || variant === 'mother_daughter') return 'mother'
  return 'father'
}

function modelNoteFor(role: ModelRole, model: SavedModel | null): string {
  if (!model) return ''
  return model.notes ? `${role} (${model.name}): ${model.notes}` : `${role} model: ${model.name}`
}

async function buildVariantNotes(
  variant: ChatTryOnVariant,
  primary: SavedModel,
  fabricNote?: string,
): Promise<{ modelNotes: string; familyExtra: string }> {
  let familyExtra = buildFamilyVariantExtra(variant, fabricNote)
  const noteParts = [primary.notes ? `Primary (${primary.name}): ${primary.notes}` : `Primary: ${primary.name}`]

  if (variant === 'mother_daughter') {
    const daughter = await getModelByRole('daughter')
    if (daughter) noteParts.push(modelNoteFor('daughter', daughter))
    familyExtra = [
      'COMPOSITION: Bangladeshi mother and young daughter (age 5–10) together in ONE scene,',
      'both wearing the SAME matching coordinated outfits from the product reference — family fashion shoot.',
      'Child proportions natural for age 5–10; garment on child sized correctly from the matching set.',
      fabricNote ?? '',
      daughter?.notes ? `Preserve daughter identity from brand library (${daughter.name}).` : '',
    ].filter(Boolean).join(' ')
  }

  if (variant === 'father_son') {
    const son = await getModelByRole('son')
    if (son) noteParts.push(modelNoteFor('son', son))
    familyExtra = [
      familyExtra,
      'Two people — father and son (age 5–12) — wearing the SAME matching collection from the product reference in ONE cohesive scene.',
      son?.notes ? `Preserve son identity from brand library (${son.name}).` : '',
    ].filter(Boolean).join(' ')
  }

  if (variant === 'mother_son') {
    const son = await getModelByRole('son')
    if (son) noteParts.push(modelNoteFor('son', son))
    familyExtra = [
      familyExtra,
      'Two people — mother and son (age 5–12) — wearing the SAME matching collection in ONE cohesive scene.',
      son?.notes ? `Preserve son identity from brand library (${son.name}).` : '',
    ].filter(Boolean).join(' ')
  }

  if (variant === 'full_family') {
    const mother = await getModelByRole('mother')
    const son = await getModelByRole('son')
    const daughter = await getModelByRole('daughter')
    if (mother) noteParts.push(modelNoteFor('mother', mother))
    if (son) noteParts.push(modelNoteFor('son', son))
    if (daughter) noteParts.push(modelNoteFor('daughter', daughter))
    familyExtra = [
      familyExtra,
      'Four people — father, mother, son, daughter — ALL wearing the SAME matching family collection in ONE scene.',
      [mother, son, daughter].filter(Boolean).map((m) => `Preserve ${m!.name} identity from brand library.`).join(' '),
    ].filter(Boolean).join(' ')
  }

  return { modelNotes: noteParts.filter(Boolean).join('; '), familyExtra }
}

export type TryOnQueueItem = {
  pendingActionId: string
  variant: ChatTryOnVariant
  label: string
  summary: string
}

export async function queueTryOnBatch(opts: {
  productImagePath: string
  modelId?: string
  variants?: ChatTryOnVariant[]
  style?: TryOnStyle
  pose?: TryOnPose
  garmentType?: string
  extra?: string
  conversationId?: string | null
}): Promise<{ items: TryOnQueueItem[]; model: SavedModel }> {
  const productImagePath = opts.productImagePath.trim()
  if (!productImagePath) throw new Error('productImagePath_required')

  const variants = (opts.variants?.length ? opts.variants : ['single']) as ChatTryOnVariant[]
  const attrs = await getOrClassifyGarment(productImagePath)
  const fabricNote = attrs.fabricGuess ? `Garment fabric: ${attrs.fabricGuess}.` : undefined

  const overrideModel = opts.modelId ? await resolveModel(opts.modelId) : null
  const items: TryOnQueueItem[] = []

  for (const variant of variants) {
    let primary: SavedModel | null = null
    if (variant === 'single' && overrideModel) {
      primary = overrideModel
    } else {
      primary = await getModelByRole(primaryRoleForVariant(variant))
      if (variant === 'single' && overrideModel) primary = overrideModel
    }
    if (!primary) {
      throw new Error(`no_model_for_${variant}`)
    }

    let modelNotes = primary.notes ?? ''
    let familyExtra = ''
    if (variant !== 'single') {
      const multi = await buildVariantNotes(variant, primary, fabricNote)
      modelNotes = multi.modelNotes
      familyExtra = multi.familyExtra
    }

    const garmentType: GarmentType =
      variant === 'single'
        ? opts.garmentType
          ? normalizeGarmentType(opts.garmentType, attrs.garmentType)
          : attrs.garmentType
        : 'family_matching_set'

    const prompt = buildTryOnPrompt({
      style: opts.style,
      pose: opts.pose,
      modelNotes,
      garmentType,
      attrs,
      extra: [familyExtra, opts.extra].filter(Boolean).join(' '),
    })

    const label = VARIANT_LABELS[variant]
    const summary =
      `🧍 On-model try-on — ${label}\n` +
      `মডেল: ${primary.name}${primary.role ? ` (${primary.role})` : ''}\n` +
      `গার্মেন্ট: ${garmentType}\n` +
      `স্টাইল: ${opts.style ?? 'studio'} | পোজ: ${opts.pose ?? 'front'}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const action = await (prisma as any).agentPendingAction.create({
      data: {
        conversationId: opts.conversationId ?? null,
        type: 'image_gen',
        payload: {
          prompt,
          quality: 'pro',
          referenceImageId: primary.imagePath,
          secondReferenceImageId: productImagePath,
          tryOn: true,
          tryOnVariant: variant,
          conversationId: opts.conversationId ?? null,
        },
        summary,
        costEstimate: variant === 'full_family' ? 6 : variant === 'single' ? 4.5 : 5.5,
        status: 'pending',
      },
    })

    items.push({
      pendingActionId: action.id as string,
      variant,
      label,
      summary,
    })
  }

  const leadModel = overrideModel ?? (await resolveModel(undefined))
  if (!leadModel) throw new Error('no_model')
  return { items, model: leadModel }
}

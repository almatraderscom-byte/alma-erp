import {
  buildTryOnPrompt,
  buildFamilyVariantExtra,
  getModelByRole,
  getOrClassifyGarment,
  type GarmentAttrs,
  type GarmentType,
  type TryOnStyle,
  type TryOnPose,
  type ModelRole,
  type SavedModel,
} from '@/lib/tryon/model-library'
import { getDesignPlaybookLines } from '@/agent/lib/taste/distill'

export type ContentVariant = 'single' | 'father_son' | 'mother_son' | 'full_family'
export type RenderQuality = 'draft' | 'pro'

export const PHASE1_VARIANTS: ContentVariant[] = ['single', 'father_son']
export const PHASE2_FAMILY_VARIANTS: ContentVariant[] = ['mother_son', 'full_family']
export const PHASE2_FULL_VARIANTS: ContentVariant[] = [
  'single',
  'father_son',
  'mother_son',
  'full_family',
]

export type ProductAsset = {
  productCode: string
  name: string | null
  category: string | null
  fabric: string | null
  imagePath: string
  familyMatch: boolean
}

export type VariantRenderSpec = {
  variant: ContentVariant
  quality: RenderQuality
  /** Worker/Gemini quality flag — draft maps to cheap `standard`. */
  workerQuality: 'standard' | 'pro'
  prompt: string
  modelImagePath: string
  productImagePath: string
  costEstimate: number
}

export function toWorkerQuality(quality: RenderQuality): 'standard' | 'pro' {
  return quality === 'draft' ? 'standard' : 'pro'
}

function primaryRoleForVariant(variant: ContentVariant): ModelRole {
  if (variant === 'single') return 'single'
  if (variant === 'mother_son') return 'mother'
  return 'father'
}

const VARIANT_LABELS: Record<ContentVariant, string> = {
  single: 'সিঙ্গেল মডেল',
  father_son: 'বাবা + ছেলে',
  mother_son: 'মা + ছেলে',
  full_family: 'পুরো ফ্যামিলি',
}

export function variantLabel(variant: ContentVariant): string {
  return VARIANT_LABELS[variant] ?? variant
}

function modelNoteFor(role: ModelRole, model: SavedModel | null): string {
  if (!model) return ''
  return model.notes
    ? `${role} (${model.name}): ${model.notes}`
    : `${role} model: ${model.name}`
}

async function buildMultiPersonNotes(
  variant: ContentVariant,
  primary: SavedModel,
): Promise<{ modelNotes: string; familyExtra: string }> {
  let familyExtra = buildFamilyVariantExtra(variant, undefined)
  const noteParts = [primary.notes ? `Primary (${primary.name}): ${primary.notes}` : `Primary: ${primary.name}`]

  if (variant === 'father_son') {
    const son = await getModelByRole('son')
    if (son) noteParts.push(modelNoteFor('son', son))
    familyExtra = [
      familyExtra,
      'Two people — father and son — wearing the SAME matching collection from the product reference in ONE cohesive scene.',
      'Bangladeshi family photoshoot aesthetic, true-to-fabric, coordinated outfits, consistent lighting with other variants of this product.',
      son?.notes ? `Preserve son identity from brand library (${son.name}).` : '',
    ].filter(Boolean).join(' ')
  }

  if (variant === 'mother_son') {
    const son = await getModelByRole('son')
    if (son) noteParts.push(modelNoteFor('son', son))
    familyExtra = [
      familyExtra,
      'Two people — mother and son — wearing the SAME matching collection from the product reference in ONE cohesive scene.',
      'Bangladeshi family photoshoot aesthetic, true-to-fabric, coordinated outfits, consistent lighting with other variants of this product.',
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
      'Four people — father, mother, son, and daughter — ALL wearing the SAME matching family collection in ONE cohesive scene.',
      'Everyone in the matching set together; Bangladeshi family photoshoot, true-to-fabric, coordinated outfits.',
      'Keep scene/style/lighting consistent with single and father+son variants of this same product post.',
      'Best-effort 4-person composition — all faces visible, natural family grouping.',
      [mother, son, daughter].filter(Boolean).map((m) => `Preserve ${m!.name} identity from brand library.`).join(' '),
    ].filter(Boolean).join(' ')
  }

  return { modelNotes: noteParts.filter(Boolean).join('; '), familyExtra }
}

export async function buildVariantRenderSpec(
  product: ProductAsset,
  variant: ContentVariant,
  quality: RenderQuality,
  opts?: { style?: TryOnStyle; pose?: TryOnPose; seedNote?: string; attrs?: GarmentAttrs },
): Promise<VariantRenderSpec> {
  const primary = await getModelByRole(primaryRoleForVariant(variant))
  if (!primary) throw new Error('no_model_for_variant')

  const attrs = opts?.attrs
  const style = opts?.style ?? 'studio'
  const pose: TryOnPose = opts?.pose ?? 'front'
  const seedNote = opts?.seedNote ? `Regeneration note: ${opts.seedNote}` : ''

  let modelNotes = primary.notes ?? ''
  let familyExtra = buildFamilyVariantExtra(variant, product.fabric ?? undefined)

  if (variant !== 'single') {
    const multi = await buildMultiPersonNotes(variant, primary)
    modelNotes = multi.modelNotes
    familyExtra = [multi.familyExtra, product.fabric ? `Garment fabric/details: ${product.fabric}.` : '']
      .filter(Boolean)
      .join(' ')
  }

  const garmentType: GarmentType = variant === 'single'
    ? (attrs?.garmentType ?? 'unknown')
    : 'family_matching_set'

  const prompt = buildTryOnPrompt({
    style,
    pose,
    modelNotes,
    garmentType,
    attrs,
    extra: [familyExtra, seedNote].filter(Boolean).join(' '),
  })

  const designRules = await getDesignPlaybookLines()
  const designExtra = designRules.length
    ? `OWNER DESIGN TASTE RULES (follow strictly): ${designRules.join(' | ')}`
    : ''

  const finalPrompt = designExtra ? `${prompt} ${designExtra}` : prompt

  return {
    variant,
    quality,
    workerQuality: toWorkerQuality(quality),
    prompt: finalPrompt,
    modelImagePath: primary.imagePath,
    productImagePath: product.imagePath,
    costEstimate: quality === 'pro' ? 4.5 : 1.1,
  }
}

export async function generateProductVariants(args: {
  product?: ProductAsset
  productCode?: string
  variants: ContentVariant[]
  quality: RenderQuality
  style?: TryOnStyle
  seedNote?: string
}): Promise<VariantRenderSpec[]> {
  let product = args.product
  if (!product && args.productCode) {
    const { prisma } = await import('@/lib/prisma')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).productContentAsset.findFirst({
      where: { productCode: args.productCode.trim() },
    })
    if (row) {
      product = {
        productCode: row.productCode,
        name: row.name,
        category: row.category,
        fabric: row.fabric,
        imagePath: row.imagePath,
        familyMatch: row.familyMatch,
      }
    }
  }
  if (!product) throw new Error('product_not_found')

  const attrs = await getOrClassifyGarment(product.imagePath, product.productCode)

  const specs: VariantRenderSpec[] = []
  for (let i = 0; i < args.variants.length; i++) {
    const variant = args.variants[i]
    const renderQuality: RenderQuality = i === 0 ? 'pro' : 'draft'
    specs.push(
      await buildVariantRenderSpec(product, variant, renderQuality, {
        style: args.style,
        seedNote: args.seedNote,
        attrs,
      }),
    )
  }
  return specs
}

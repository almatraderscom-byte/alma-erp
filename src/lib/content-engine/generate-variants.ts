import {
  buildTryOnPrompt,
  buildFamilyVariantExtra,
  getModelByRole,
  type TryOnStyle,
  type TryOnPose,
  type ModelRole,
} from '@/lib/tryon/model-library'

export type ContentVariant = 'single' | 'father_son' | 'mother_son' | 'full_family'
export type RenderQuality = 'draft' | 'pro'

export const PHASE1_VARIANTS: ContentVariant[] = ['single', 'father_son']

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

function modelRoleForVariant(variant: ContentVariant): ModelRole {
  if (variant === 'single') return 'single'
  if (variant === 'father_son' || variant === 'mother_son' || variant === 'full_family') return 'father'
  return 'single'
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

export async function buildVariantRenderSpec(
  product: ProductAsset,
  variant: ContentVariant,
  quality: RenderQuality,
  opts?: { style?: TryOnStyle; pose?: TryOnPose; seedNote?: string },
): Promise<VariantRenderSpec> {
  const model = await getModelByRole(modelRoleForVariant(variant))
  if (!model) throw new Error('no_model_for_variant')

  const style = opts?.style ?? 'studio'
  const pose: TryOnPose = opts?.pose ?? 'front'
  let familyExtra = buildFamilyVariantExtra(variant, product.fabric ?? undefined)
  const seedNote = opts?.seedNote ? `Regeneration note: ${opts.seedNote}` : ''

  let modelNotes = model.notes
  if (variant === 'father_son') {
    const son = await getModelByRole('son')
    if (son) {
      const sonNote = son.notes ? `Son (${son.name}): ${son.notes}` : `Son model: ${son.name}`
      modelNotes = [model.notes, sonNote].filter(Boolean).join('; ')
      familyExtra = [
        familyExtra,
        'Two people (father and son) wearing the matching garment set in the same scene — Bangladeshi family photoshoot, true-to-fabric, coordinated outfits.',
        son.notes ? `Preserve son identity from brand library (${son.name}).` : '',
      ].filter(Boolean).join(' ')
    }
  }

  const prompt = buildTryOnPrompt({
    style,
    pose,
    modelNotes,
    garmentType: product.category ?? product.name ?? product.productCode,
    extra: [familyExtra, seedNote].filter(Boolean).join(' '),
  })

  return {
    variant,
    quality,
    workerQuality: toWorkerQuality(quality),
    prompt,
    modelImagePath: model.imagePath,
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

  const specs: VariantRenderSpec[] = []
  for (const variant of args.variants) {
    specs.push(
      await buildVariantRenderSpec(product, variant, args.quality, {
        style: args.style,
        seedNote: args.seedNote,
      }),
    )
  }
  return specs
}

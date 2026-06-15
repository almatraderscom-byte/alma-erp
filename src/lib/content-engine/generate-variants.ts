import {
  buildTryOnPrompt,
  buildFamilyVariantExtra,
  resolveModelByRole,
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
  prompt: string
  modelImagePath: string
  productImagePath: string
  costEstimate: number
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
  const model = await resolveModelByRole(modelRoleForVariant(variant))
  if (!model) throw new Error('no_model_for_variant')

  const style = opts?.style ?? 'studio'
  const pose: TryOnPose = opts?.pose ?? 'front'
  const familyExtra = buildFamilyVariantExtra(variant, product.fabric ?? undefined)
  const seedNote = opts?.seedNote ? `Regeneration note: ${opts.seedNote}` : ''

  const prompt = buildTryOnPrompt({
    style,
    pose,
    modelNotes: model.notes,
    garmentType: product.category ?? product.name ?? product.productCode,
    extra: [familyExtra, seedNote].filter(Boolean).join(' '),
  })

  return {
    variant,
    quality,
    prompt,
    modelImagePath: model.imagePath,
    productImagePath: product.imagePath,
    costEstimate: quality === 'pro' ? 4.5 : 1.1,
  }
}

export async function generateProductVariants(args: {
  product: ProductAsset
  variants: ContentVariant[]
  quality: RenderQuality
  style?: TryOnStyle
}): Promise<VariantRenderSpec[]> {
  const specs: VariantRenderSpec[] = []
  for (const variant of args.variants) {
    specs.push(await buildVariantRenderSpec(args.product, variant, args.quality, { style: args.style }))
  }
  return specs
}

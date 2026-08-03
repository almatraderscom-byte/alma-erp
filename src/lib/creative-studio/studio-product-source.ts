import type { StudioProductOption } from '@/lib/creative-studio/project-contract'

export type StudioCatalogProductImage = {
  storagePath: string
  url: string | null
}

export function isLegacyStudioProductPath(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith('/agent/product-images/'))
}

export function studioProductPreviewUrl(
  product: StudioProductOption,
  signed: Record<string, string>,
): string | null {
  const source = product.sourceImage
  const isStoragePath = Boolean(source && !/^https?:\/\//i.test(source) && !source.startsWith('/'))
  if (source && isStoragePath) return signed[source] ?? product.previewImage ?? null
  return product.previewImage ?? source ?? null
}

/**
 * Older Studio projects persisted a UI route instead of the private object path.
 * A paid generation must receive the healthy catalog object's stable path, while
 * the signed URL remains preview-only. The caller must resolve `catalogImage`
 * from the exact project/product SKU before using this helper.
 */
export function hydrateLegacyStudioProduct(
  product: StudioProductOption,
  catalogImage: StudioCatalogProductImage | null | undefined,
): StudioProductOption {
  if (!isLegacyStudioProductPath(product.sourceImage)) return product
  return {
    ...product,
    sourceImage: catalogImage?.storagePath ?? null,
    previewImage: catalogImage?.url ?? null,
  }
}

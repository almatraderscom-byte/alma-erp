import type { StudioProductOption } from '@/lib/creative-studio/project-contract'

export type StudioCatalogProductImage = {
  storagePath: string
  url: string | null
}

const PRODUCT_STORAGE_PREFIX = 'product-images/'

/**
 * Recover the stable private-object path from an older persisted Supabase URL.
 * These URLs expire, but the bucket/object lineage embedded in their pathname is
 * still authoritative for the exact project product and can be signed again.
 */
export function canonicalStudioProductStoragePath(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  if (normalized.startsWith(PRODUCT_STORAGE_PREFIX)) return normalized
  try {
    const url = new URL(normalized)
    const match = url.pathname.match(
      /^\/storage\/v1\/object\/(?:sign|public)\/agent-files\/(product-images\/.*)$/i,
    )
    if (!match?.[1]) return null
    const decoded = decodeURIComponent(match[1])
    return decoded.startsWith(PRODUCT_STORAGE_PREFIX) ? decoded : null
  } catch {
    return null
  }
}

export function isLegacyStudioProductPath(value: string | null | undefined): boolean {
  const normalized = value?.trim()
  if (!normalized) return false
  if (normalized.startsWith('/agent/product-images/')) return true
  try {
    const url = new URL(normalized)
    return /^\/storage\/v1\/object\/(?:sign|public)\/agent-files\/product-images\//i
      .test(url.pathname)
  } catch {
    return false
  }
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
  const canonicalSource = canonicalStudioProductStoragePath(product.sourceImage)
  return {
    ...product,
    sourceImage: canonicalSource ?? catalogImage?.storagePath ?? null,
    previewImage: catalogImage?.url ?? null,
  }
}

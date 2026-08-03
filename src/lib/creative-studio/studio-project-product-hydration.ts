import { listProductImages } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import {
  canonicalStudioProductStoragePath,
  hydrateLegacyStudioProduct,
  isLegacyStudioProductPath,
  studioProductPreviewUrl,
} from '@/lib/creative-studio/studio-product-source'

function isRemoteOrAppPath(value: string) {
  return /^https?:\/\//i.test(value) || value.startsWith('/')
}

/**
 * Project snapshots may outlive ERP rows and signed URLs. Return the same exact
 * project/SKU metadata with a stable private-object source plus a fresh,
 * renderable preview; never persist the short-lived preview URL.
 */
export async function hydrateStudioProjectProducts(
  projects: StudioProjectSummary[],
): Promise<StudioProjectSummary[]> {
  const canonical = await Promise.all(projects.map(async (project) => {
    if (!project.product || !isLegacyStudioProductPath(project.product.sourceImage)) {
      return project
    }
    if (canonicalStudioProductStoragePath(project.product.sourceImage)) {
      return {
        ...project,
        product: hydrateLegacyStudioProduct(project.product, null),
      }
    }
    try {
      const [catalogImage] = await listProductImages(
        project.product.code,
        DEFAULT_CATALOG_BUSINESS,
        1,
      )
      return {
        ...project,
        product: hydrateLegacyStudioProduct(project.product, catalogImage),
      }
    } catch {
      return {
        ...project,
        product: hydrateLegacyStudioProduct(project.product, null),
      }
    }
  }))

  const storagePaths = canonical
    .map((project) => project.product?.sourceImage)
    .filter((path): path is string => Boolean(path) && !isRemoteOrAppPath(path!))
  let signed: Record<string, string> = {}
  if (storagePaths.length) {
    try {
      signed = await agentStorageSignedUrls([...new Set(storagePaths)], 3600)
    } catch {
      signed = {}
    }
  }

  return canonical.map((project) => project.product
    ? {
        ...project,
        product: {
          ...project.product,
          previewImage: studioProductPreviewUrl(project.product, signed),
        },
      }
    : project)
}

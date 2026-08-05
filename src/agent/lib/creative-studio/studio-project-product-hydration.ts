import { listProductImages } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import {
  canonicalStudioProductStoragePath,
  hydrateLegacyStudioProduct,
  isLegacyStudioProductPath,
} from '@/lib/creative-studio/studio-product-source'

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

  return canonical.map((project) => project.product
    ? {
        ...project,
        product: {
          ...project.product,
          previewImage: project.product.sourceImage
            && !/^https?:\/\//i.test(project.product.sourceImage)
            && !project.product.sourceImage.startsWith('/')
            && project.brandProfileId
            ? `/api/assistant/creative-studio/projects/${encodeURIComponent(project.id)}/product-preview?brandProfileId=${encodeURIComponent(project.brandProfileId)}`
            : project.product.previewImage ?? project.product.sourceImage,
        },
      }
    : project)
}

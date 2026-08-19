import { type NextRequest } from 'next/server'
import { agentStorageDownload } from '@/agent/lib/storage'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  ContentOsServiceError,
  getProject,
} from '@/lib/creative-studio/project-service'
import { hydrateStudioProjectProducts } from '@/agent/lib/creative-studio/studio-project-product-hydration'
import { listProductImages } from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const MIN_PRODUCT_IMAGE_BYTES = 1024

function contentType(path: string): string {
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.webp$/i.test(path)) return 'image/webp'
  return 'image/jpeg'
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')?.trim()
  if (!brandProfileId) {
    return Response.json({ error: 'brand_profile_required' }, { status: 422 })
  }
  try {
    const access = await requireStudioBrandAccess(actor, brandProfileId)
    const project = await getProject(access.ownerId, params.id)
    if (project.brandProfileId !== brandProfileId) {
      throw new StudioAccessError('project_access_forbidden', 403)
    }
    const [hydrated] = await hydrateStudioProjectProducts([project])
    let source = hydrated.product?.sourceImage
    if (!source || /^https?:\/\//i.test(source) || source.startsWith('/')) {
      return Response.json({ error: 'product_source_unavailable' }, { status: 404 })
    }
    let bytes = await agentStorageDownload(source)
    if (bytes.byteLength < MIN_PRODUCT_IMAGE_BYTES && project.product?.code) {
      const fallbacks = await listProductImages(
        project.product.code,
        DEFAULT_CATALOG_BUSINESS,
        8,
      )
      for (const candidate of fallbacks) {
        if (candidate.storagePath === source) continue
        const candidateBytes = await agentStorageDownload(candidate.storagePath)
        if (candidateBytes.byteLength < MIN_PRODUCT_IMAGE_BYTES) continue
        source = candidate.storagePath
        bytes = candidateBytes
        break
      }
    }
    if (bytes.byteLength < MIN_PRODUCT_IMAGE_BYTES) {
      return Response.json({ error: 'product_source_corrupt' }, { status: 422 })
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Length': String(bytes.byteLength),
        'Content-Type': contentType(source),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    if (error instanceof ContentOsServiceError) {
      return Response.json({ error: error.code }, { status: error.status })
    }
    return studioAccessErrorResponse(error, 'creative-project-product-preview')
  }
}

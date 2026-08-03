import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import { isSystemOwner } from '@/lib/roles'
import {
  ContentOsServiceError,
  searchErpProducts,
} from '@/lib/creative-studio/project-service'
import {
  listProductImages,
} from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS } from '@/agent/lib/catalog/inventory-lookup'
import {
  hydrateLegacyStudioProduct,
  isLegacyStudioProductPath,
  studioProductPreviewUrl,
} from '@/lib/creative-studio/studio-product-source'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function ownerAllowed(req: NextRequest): Promise<Response | null> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

function isRemoteOrAppPath(value: string) {
  return /^https?:\/\//i.test(value) || value.startsWith('/')
}

export async function GET(req: NextRequest) {
  const denied = await ownerAllowed(req)
  if (denied) return denied
  try {
    const products = await searchErpProducts(req.nextUrl.searchParams.get('q') ?? '')
    const hydratedProducts = await Promise.all(products.map(async (product) => {
      if (!isLegacyStudioProductPath(product.sourceImage)) return product
      try {
        const [catalogImage] = await listProductImages(
          product.code,
          DEFAULT_CATALOG_BUSINESS,
          1,
        )
        return hydrateLegacyStudioProduct(product, catalogImage)
      } catch {
        return { ...product, sourceImage: null, previewImage: null }
      }
    }))
    // Legacy hydration can replace a UI route with the exact catalog object
    // path. Build the signing batch afterwards so that canonical source gets a
    // renderable preview even when the older cached catalog URL is unavailable.
    const storagePaths = hydratedProducts
      .map((product) => product.sourceImage)
      .filter((path): path is string => Boolean(path) && !isRemoteOrAppPath(path!))
    let signed: Record<string, string> = {}
    if (storagePaths.length) {
      try {
        signed = await agentStorageSignedUrls([...new Set(storagePaths)], 3600)
      } catch {
        signed = {}
      }
    }
    return Response.json({
      products: hydratedProducts.map((product) => ({
        ...product,
        previewImage: studioProductPreviewUrl(product, signed),
      })),
      readOnly: true,
    })
  } catch (error) {
    if (error instanceof ContentOsServiceError) {
      return Response.json({ error: error.code }, { status: error.status })
    }
    console.error('[creative-products] read failed', error)
    return Response.json({ error: 'products_failed' }, { status: 500 })
  }
}

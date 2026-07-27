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

function isLegacyAppProductPath(value: string | null) {
  return Boolean(value?.startsWith('/agent/product-images/'))
}

export async function GET(req: NextRequest) {
  const denied = await ownerAllowed(req)
  if (denied) return denied
  try {
    const products = await searchErpProducts(req.nextUrl.searchParams.get('q') ?? '')
    const storagePaths = products
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
    const hydratedProducts = await Promise.all(products.map(async (product) => {
      if (!isLegacyAppProductPath(product.sourceImage)) return product
      try {
        const [catalogImage] = await listProductImages(
          product.code,
          DEFAULT_CATALOG_BUSINESS,
          1,
        )
        return {
          ...product,
          // The project snapshot still owns generation lineage. A catalog image
          // may repair the visual preview, but a read route must not silently
          // replace that authoritative source path for a paid run.
          sourceImage: null,
          previewImage: catalogImage?.url ?? null,
        }
      } catch {
        return { ...product, sourceImage: null, previewImage: null }
      }
    }))
    return Response.json({
      products: hydratedProducts.map((product) => ({
        ...product,
        previewImage: product.previewImage
          ?? (product.sourceImage && !isRemoteOrAppPath(product.sourceImage)
            ? signed[product.sourceImage] ?? null
            : product.sourceImage),
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

import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { canManageCatalogImages, isSystemOwner } from '@/lib/roles'
import {
  listProductImages,
  addProductImage,
  deleteImageFromGroup,
} from '@/agent/lib/catalog/product-images'
import { DEFAULT_CATALOG_BUSINESS, resolveProductInput } from '@/agent/lib/catalog/inventory-lookup'

export const runtime = 'nodejs'
export const maxDuration = 60

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']
const HEIC_EXTS = ['heic', 'heif']
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

function isHeic(type: string, ext: string): boolean {
  return HEIC_TYPES.includes(type.toLowerCase()) || HEIC_EXTS.includes(ext.toLowerCase())
}

/**
 * Gate a request. `level: 'manage'` allows SUPER_ADMIN + ADMIN (view/upload);
 * `level: 'owner'` is SUPER_ADMIN-only (delete). Returns the token on success so
 * the caller never re-reads it.
 */
async function requireRole(req: NextRequest, level: 'manage' | 'owner') {
  const disabled = requireAgentEnabled()
  if (disabled) return { res: disabled }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { res: Response.json({ error: 'unauthorized' }, { status: 401 }) }
  const ok = level === 'owner' ? isSystemOwner(token) : canManageCatalogImages(token)
  if (!ok) return { res: Response.json({ error: 'forbidden' }, { status: 403 }) }
  return { res: null }
}

/**
 * For a collection card the card's `code` is the collection base (not a real SKU
 * in the image store — photos live under each member). Resolve to the member that
 * actually holds images so the gallery shows them; fall back to the first member.
 */
async function listCodeFor(code: string, business: string): Promise<string> {
  const resolved = await resolveProductInput(code)
  if (resolved.kind === 'collection') {
    const members = resolved.members.map((m) => m.sku)
    for (const m of members) {
      const imgs = await listProductImages(m, business, 1)
      if (imgs.length) return m
    }
    return members[0] ?? code
  }
  if (resolved.kind === 'sku') return resolved.code
  return code
}

// GET → all images for the product/collection (primary first).
export async function GET(req: NextRequest, { params }: { params: { code: string } }) {
  const gate = await requireRole(req, 'manage')
  if (gate.res) return gate.res

  const business = req.nextUrl.searchParams.get('business') || DEFAULT_CATALOG_BUSINESS
  const code = decodeURIComponent(params.code)
  try {
    const listCode = await listCodeFor(code, business)
    const images = await listProductImages(listCode, business, 12)
    return Response.json({ ok: true, code, listCode, images })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown'
    console.error('[assistant/catalog/images GET] failed:', detail)
    return Response.json({ ok: false, error: 'list_failed', detail }, { status: 502 })
  }
}

// POST → upload one or more photos (replicated across collection members).
export async function POST(req: NextRequest, { params }: { params: { code: string } }) {
  const gate = await requireRole(req, 'manage')
  if (gate.res) return gate.res

  const code = decodeURIComponent(params.code)

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const business = formData.get('business')?.toString() || DEFAULT_CATALOG_BUSINESS
  const files = formData.getAll('file').filter((f): f is File => f instanceof File)
  if (!files.length) return Response.json({ error: 'file_required' }, { status: 400 })

  const uploadedByChatId = formData.get('uploadedByChatId')?.toString() || 'owner-web'
  const results: unknown[] = []

  for (const file of files) {
    const rawExt = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
    const heic = isHeic(file.type, rawExt)
    if (!ALLOWED_TYPES.includes(file.type) && !heic) {
      return Response.json(
        { error: 'unsupported_file_type', allowed: [...ALLOWED_TYPES, ...HEIC_TYPES] },
        { status: 415 },
      )
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: 'file_too_large', maxMb: 10 }, { status: 413 })
    }

    let buffer = Buffer.from(await file.arrayBuffer())
    let contentType = file.type || 'image/jpeg'

    // iPhone HEIC/HEIF → JPEG so previews + Facebook upload work everywhere.
    if (heic) {
      try {
        const sharp = (await import('sharp')).default
        buffer = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer()
        contentType = 'image/jpeg'
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown'
        console.error('[assistant/catalog/images POST] HEIC convert failed:', detail)
        return Response.json({ error: 'heic_convert_failed', detail }, { status: 422 })
      }
    }

    const result = await addProductImage({
      productCode: code,
      business,
      imageBuffer: buffer,
      uploadedByChatId,
      contentType,
    })
    if (!result.ok) {
      // invalid_code etc. — stop and report (with suggestions when present).
      return Response.json(result, { status: 400 })
    }
    results.push(result)
  }

  return Response.json({ ok: true, code, uploaded: results.length, results })
}

// DELETE → remove one photo (across all collection members at that index).
export async function DELETE(req: NextRequest, { params }: { params: { code: string } }) {
  // Delete is destructive → SUPER_ADMIN only (Admins can add but not remove).
  const gate = await requireRole(req, 'owner')
  if (gate.res) return gate.res

  const code = decodeURIComponent(params.code)
  const business = req.nextUrl.searchParams.get('business') || DEFAULT_CATALOG_BUSINESS
  const imageId = req.nextUrl.searchParams.get('imageId')
  if (!imageId) return Response.json({ error: 'imageId_required' }, { status: 400 })

  try {
    const result = await deleteImageFromGroup(code, imageId, business)
    if (!result.ok) return Response.json(result, { status: 404 })
    return Response.json({ ok: true, code, deleted: result.deleted })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown'
    console.error('[assistant/catalog/images DELETE] failed:', detail)
    return Response.json({ ok: false, error: 'delete_failed', detail }, { status: 502 })
  }
}

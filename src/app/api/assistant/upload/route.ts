import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageUpload } from '@/agent/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 30

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
// iPhone photos arrive as HEIC/HEIF (and iOS often sends an empty / octet-stream
// mime type). Accept them here and convert to JPEG below so uploads never error.
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']
const HEIC_EXTS = ['heic', 'heif']
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

function isHeic(type: string, ext: string): boolean {
  return HEIC_TYPES.includes(type.toLowerCase()) || HEIC_EXTS.includes(ext.toLowerCase())
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return Response.json({ error: 'file_required' }, { status: 400 })
  const rawExt = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  const heic = isHeic(file.type, rawExt)
  if (!ALLOWED_TYPES.includes(file.type) && !heic) {
    return Response.json({ error: 'unsupported_file_type', allowed: [...ALLOWED_TYPES, ...HEIC_TYPES] }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'file_too_large', maxMb: 10 }, { status: 413 })
  }

  const conversationId = formData.get('conversationId')?.toString() ?? 'general'

  let buffer = Buffer.from(await file.arrayBuffer())
  let contentType = file.type || 'application/octet-stream'
  let ext = rawExt

  // Convert iPhone HEIC/HEIF → JPEG so downstream (preview, sharp framing, Facebook
  // upload) all work. sharp's prebuilt binary ships libheif on the Vercel linux-x64
  // runtime. Best-effort: if conversion fails, surface a clear error.
  if (heic) {
    try {
      const sharp = (await import('sharp')).default
      buffer = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer()
      contentType = 'image/jpeg'
      ext = 'jpg'
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      console.error('[assistant/upload] HEIC convert failed:', detail)
      return Response.json({ error: 'heic_convert_failed', detail }, { status: 422 })
    }
  }

  const objectPath = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  // Storage can throw when Supabase env is missing on this deployment (a common
  // Preview-vs-Production env gap) or when the bucket call fails. Surface the
  // real reason instead of letting it become a silent 500 → generic "upload_failed".
  try {
    const result = await agentStorageUpload(objectPath, buffer, contentType)
    return Response.json({ bucket: result.bucket, path: result.objectPath, mediaType: contentType }, { status: 201 })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown storage error'
    console.error('[assistant/upload] storage upload failed:', detail)
    return Response.json({ error: 'storage_unavailable', detail }, { status: 502 })
  }
}

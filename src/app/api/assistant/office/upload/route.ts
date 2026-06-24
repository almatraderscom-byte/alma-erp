/**
 * POST /api/assistant/office/upload
 * Staff (or owner) uploads a task-proof image. Returns a long-lived signed URL
 * stored later in the task's proofData so the owner can review it in the hub.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageUpload, agentStorageSignedUrl } from '@/agent/lib/storage'
import { resolveSessionStaff } from '@/agent/lib/office-staff'

export const runtime = 'nodejs'
export const maxDuration = 30

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']
const HEIC_EXTS = ['heic', 'heif']
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const SIGNED_TTL = 60 * 60 * 24 * 365 // 1 year

function isHeic(type: string, ext: string): boolean {
  return HEIC_TYPES.includes(type.toLowerCase()) || HEIC_EXTS.includes(ext.toLowerCase())
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const staff = await resolveSessionStaff(token.sub)
  if (!staff && !isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  const scope = staff?.id ?? 'owner'

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
    return Response.json({ error: 'unsupported_file_type' }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'file_too_large', maxMb: 10 }, { status: 413 })
  }

  let buffer = Buffer.from(await file.arrayBuffer())
  let contentType = file.type || 'application/octet-stream'
  let ext = rawExt

  if (heic) {
    try {
      const sharp = (await import('sharp')).default
      buffer = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer()
      contentType = 'image/jpeg'
      ext = 'jpg'
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown'
      return Response.json({ error: 'heic_convert_failed', detail }, { status: 422 })
    }
  }

  const objectPath = `office-proofs/${scope}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  try {
    await agentStorageUpload(objectPath, buffer, contentType)
    const url = await agentStorageSignedUrl(objectPath, SIGNED_TTL)
    return Response.json({ path: objectPath, url, mediaType: contentType }, { status: 201 })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown storage error'
    console.error('[office/upload] storage failed:', detail)
    return Response.json({ error: 'storage_unavailable', detail }, { status: 502 })
  }
}

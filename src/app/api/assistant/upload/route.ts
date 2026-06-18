import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageUpload } from '@/agent/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 30

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

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
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json({ error: 'unsupported_file_type', allowed: ALLOWED_TYPES }, { status: 415 })
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: 'file_too_large', maxMb: 10 }, { status: 413 })
  }

  const conversationId = formData.get('conversationId')?.toString() ?? 'general'
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  const objectPath = `${conversationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const buffer = Buffer.from(await file.arrayBuffer())

  // Storage can throw when Supabase env is missing on this deployment (a common
  // Preview-vs-Production env gap) or when the bucket call fails. Surface the
  // real reason instead of letting it become a silent 500 → generic "upload_failed".
  try {
    const result = await agentStorageUpload(objectPath, buffer, file.type)
    return Response.json({ bucket: result.bucket, path: result.objectPath, mediaType: file.type }, { status: 201 })
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown storage error'
    console.error('[assistant/upload] storage upload failed:', detail)
    return Response.json({ error: 'storage_unavailable', detail }, { status: 502 })
  }
}

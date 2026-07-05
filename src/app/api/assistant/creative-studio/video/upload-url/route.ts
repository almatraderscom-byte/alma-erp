// Phase V1: signed direct-upload URL for the owner's phone-shot videos.
// The browser PUTs the file straight to Supabase storage — Vercel never sees
// the (up to ~500 MB) body.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { randomUUID } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUploadUrl } from '@/agent/lib/storage'
import { VIDEO_UPLOAD_MAX_BYTES, VIDEO_UPLOAD_EXTENSIONS } from '@/lib/creative-studio/video-recipes'

export const runtime = 'nodejs'

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { fileName?: string; sizeBytes?: number }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const fileName = String(body.fileName ?? '').trim()
  const sizeBytes = Number(body.sizeBytes ?? 0)
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!(VIDEO_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return Response.json({ error: 'শুধু iPhone/ফোনের ভিডিও ফাইল দিন (mp4 / mov)।' }, { status: 422 })
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > VIDEO_UPLOAD_MAX_BYTES) {
    return Response.json({ error: 'ভিডিওটি ৫০০ MB-এর মধ্যে হতে হবে (১–২ মিনিটের শুট)।' }, { status: 422 })
  }

  const uploadId = randomUUID()
  const path = `studio-video/uploads/${uploadId}.${ext === 'm4v' ? 'mp4' : ext}`
  try {
    const uploadUrl = await agentStorageSignedUploadUrl(path)
    return Response.json({
      ok: true,
      uploadId,
      path,
      uploadUrl,
      contentType: CONTENT_TYPES[ext] ?? 'video/mp4',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[studio-video] signed upload URL failed:', msg)
    return Response.json({ error: 'upload_url_failed' }, { status: 500 })
  }
}

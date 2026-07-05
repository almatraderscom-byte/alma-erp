// Phase V2: signed direct-upload URL for owner-approved music beds.
// Owner uploads his own approved tracks only (Islamic guardrail) — the system
// never fetches music from anywhere else.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { randomUUID } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUploadUrl } from '@/agent/lib/storage'
import { MUSIC_UPLOAD_MAX_BYTES, MUSIC_UPLOAD_EXTENSIONS } from '@/lib/creative-studio/video-recipes'

export const runtime = 'nodejs'

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
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
  if (!(MUSIC_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return Response.json({ error: 'অডিও ফাইল দিন (mp3 / m4a / wav)।' }, { status: 422 })
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MUSIC_UPLOAD_MAX_BYTES) {
    return Response.json({ error: 'ট্র্যাকটি ২৫ MB-এর মধ্যে হতে হবে।' }, { status: 422 })
  }

  const uploadId = randomUUID()
  const path = `studio-video/music/${uploadId}.${ext}`
  try {
    const uploadUrl = await agentStorageSignedUploadUrl(path)
    return Response.json({
      ok: true,
      uploadId,
      path,
      uploadUrl,
      contentType: CONTENT_TYPES[ext] ?? 'audio/mpeg',
    })
  } catch (err) {
    console.error('[studio-music] signed upload URL failed:', err instanceof Error ? err.message : err)
    return Response.json({ error: 'upload_url_failed' }, { status: 500 })
  }
}

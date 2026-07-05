// E1: signed direct upload for voice samples / voice notes (audio files).
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { randomUUID } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUploadUrl } from '@/agent/lib/storage'
import { AUDIO_UPLOAD_EXTENSIONS, AUDIO_UPLOAD_MAX_BYTES } from '@/lib/creative-studio/audio-lab'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { fileName?: string; sizeBytes?: number }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const ext = String(body.fileName ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (!(AUDIO_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return Response.json({ error: 'অডিও ফাইল দিন (mp3 / m4a / wav / ogg)।' }, { status: 422 })
  }
  const size = Number(body.sizeBytes ?? 0)
  if (!Number.isFinite(size) || size <= 0 || size > AUDIO_UPLOAD_MAX_BYTES) {
    return Response.json({ error: 'ফাইলটি ২৫ MB-এর মধ্যে হতে হবে।' }, { status: 422 })
  }

  const path = `studio-video/audio/${randomUUID()}.${ext}`
  const uploadUrl = await agentStorageSignedUploadUrl(path)
  return Response.json({ ok: true, path, uploadUrl, contentType: `audio/${ext === 'mp3' ? 'mpeg' : ext}` })
}

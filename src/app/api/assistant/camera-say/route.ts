// Camera speak API (owner-only) — queue a Bangla announcement for an office
// camera speaker. POST {text, camera?} → TTS MP3 + queued bridge job; the
// office-PC bridge (camera-bridge route) picks it up and plays it via go2rtc.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { queueCameraSpeak } from '@/agent/lib/camera-say'

export const runtime = 'nodejs'
export const maxDuration = 60

async function ownerOnly(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

interface SpeakBody {
  text?: string
  camera?: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const unauth = await ownerOnly()
  if (unauth) return unauth

  let body: SpeakBody
  try {
    body = (await req.json()) as SpeakBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'text required' }, { status: 400 })
  }

  try {
    const { jobId, stream } = await queueCameraSpeak({ text: body.text, camera: body.camera })
    return NextResponse.json({ ok: true, jobId, stream })
  } catch (err) {
    console.warn('[camera-say] queue failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { error: 'ঘোষণা তৈরি করা যায়নি — একটু পরে আবার চেষ্টা করুন।' },
      { status: 500 },
    )
  }
}

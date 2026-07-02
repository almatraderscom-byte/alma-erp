// Known-people registry API (owner-only) — backs the /agent/known-people page.
// GET  → list people (+ signed thumbnail URLs) + entrance-watch settings
// POST → register a person with base64 reference photos
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  listKnownPeople, createKnownPerson, knownPeopleThumbUrls, MAX_PHOTOS_PER_PERSON,
} from '@/agent/lib/known-people'
import { getEntranceSettings } from '@/agent/lib/entrance-watch'

export const runtime = 'nodejs'
export const maxDuration = 60

async function ownerOnly(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET() {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const unauth = await ownerOnly()
  if (unauth) return unauth

  const people = await listKnownPeople({ includeInactive: true })
  const thumbs = await knownPeopleThumbUrls(people)
  const settings = await getEntranceSettings()
  return NextResponse.json({ people, thumbs, settings, maxPhotos: MAX_PHOTOS_PER_PERSON })
}

interface CreateBody {
  name?: string
  role?: string
  note?: string
  photos?: Array<{ base64?: string; mimeType?: string }>
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const unauth = await ownerOnly()
  if (unauth) return unauth

  let body: CreateBody
  try {
    body = (await req.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const photos = (body.photos ?? [])
    .filter((p) => typeof p.base64 === 'string' && p.base64.length > 0)
    .map((p) => ({ base64: p.base64!, mimeType: p.mimeType || 'image/jpeg' }))
  if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (photos.length === 0) return NextResponse.json({ error: 'at least one photo required' }, { status: 400 })

  try {
    const person = await createKnownPerson({
      name: body.name, role: body.role, note: body.note, photos,
    })
    return NextResponse.json({ ok: true, person })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'create failed' },
      { status: 500 },
    )
  }
}

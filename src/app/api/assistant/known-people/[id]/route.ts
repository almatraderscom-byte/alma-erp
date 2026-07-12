// Single known-person API (owner-only): PATCH updates name/role/active/photos,
// DELETE removes the person entirely.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { addKnownPersonPhotos, deleteKnownPerson, replaceKnownPersonPhotos, updateKnownPerson } from '@/agent/lib/known-people'

export const runtime = 'nodejs'
export const maxDuration = 60

async function ownerOnly(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

interface PatchBody {
  name?: string
  role?: string
  active?: boolean
  note?: string
  addPhotos?: Array<{ base64?: string; mimeType?: string }>
  /** Swap ALL reference photos (native photo-change). */
  replacePhotos?: Array<{ base64?: string; mimeType?: string }>
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const unauth = await ownerOnly()
  if (unauth) return unauth

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  try {
    let person = await updateKnownPerson(params.id, {
      name: body.name, role: body.role, active: body.active, note: body.note,
    })
    const addPhotos = (body.addPhotos ?? [])
      .filter((p) => typeof p.base64 === 'string' && p.base64.length > 0)
      .map((p) => ({ base64: p.base64!, mimeType: p.mimeType || 'image/jpeg' }))
    if (addPhotos.length > 0) {
      person = await addKnownPersonPhotos(params.id, addPhotos)
    }
    const replacePhotos = (body.replacePhotos ?? [])
      .filter((p) => typeof p.base64 === 'string' && p.base64.length > 0)
      .map((p) => ({ base64: p.base64!, mimeType: p.mimeType || 'image/jpeg' }))
    if (replacePhotos.length > 0) {
      person = await replaceKnownPersonPhotos(params.id, replacePhotos)
    }
    return NextResponse.json({ ok: true, person })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'update failed' },
      { status: 500 },
    )
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const unauth = await ownerOnly()
  if (unauth) return unauth

  try {
    await deleteKnownPerson(params.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'delete failed' },
      { status: 500 },
    )
  }
}

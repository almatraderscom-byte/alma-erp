import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  addBrandModel,
  getModelLibrary,
  removeBrandModel,
  setDefaultBrandModel,
  listModelsByRole,
  type ModelRole,
} from '@/lib/tryon/model-library'

export const runtime = 'nodejs'

const VALID_ROLES = new Set<ModelRole>(['father', 'mother', 'son', 'daughter', 'single'])

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const [models, byRole] = await Promise.all([getModelLibrary(), listModelsByRole()])
  return Response.json({ models, byRole })
}

export async function POST(req: NextRequest) {
  const denied = await requireOwner(req)
  if (denied) return denied

  let body: {
    action?: string
    id?: string
    name?: string
    imagePath?: string
    role?: string
    notes?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = String(body.action ?? 'add')

  // Wrap all DB work so a real failure returns its actual message as JSON. Without
  // this an exception (e.g. the agent_brand_models table not yet migrated on
  // production) fell through to Next's default 500 HTML page, and the Model
  // Library UI could only show a useless generic "save_failed".
  try {
    if (action === 'remove') {
      const id = String(body.id ?? '').trim().toLowerCase()
      const ok = await removeBrandModel(id)
      if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json({ ok: true })
    }

    if (action === 'set_default') {
      const id = String(body.id ?? '').trim().toLowerCase()
      const ok = await setDefaultBrandModel(id)
      if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json({ ok: true })
    }

    const id = String(body.id ?? body.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
    const name = String(body.name ?? '').trim()
    const imagePath = String(body.imagePath ?? '').trim()
    const role = body.role as ModelRole | undefined
    if (!id || !name || !imagePath) {
      return Response.json({ error: 'id_name_imagePath_required' }, { status: 400 })
    }
    if (!role || !VALID_ROLES.has(role)) {
      return Response.json({ error: 'invalid_role' }, { status: 400 })
    }

    const saved = await addBrandModel({
      id,
      name,
      imagePath,
      isDefault: false,
      notes: body.notes ? String(body.notes) : undefined,
      role,
    })

    return Response.json({ model: saved }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[assistant/brand-models] save failed', err)
    const missingTable = /relation .* does not exist/i.test(message)
      || /agent_brand_models|agent_kv_settings/i.test(message)
      || /P2021|P2010/.test(message)
    if (missingTable) {
      return Response.json({
        error: 'db_not_migrated',
        message: 'Model Library table production-এ নেই — prisma migrate deploy চালান।',
      }, { status: 503 })
    }
    return Response.json({ error: 'save_failed', message }, { status: 500 })
  }
}

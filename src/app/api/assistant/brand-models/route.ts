import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import {
  addBrandModel,
  getModelLibrary,
  removeBrandModel,
  setDefaultBrandModel,
  listModelsByRole,
  type ModelRole,
} from '@/lib/tryon/model-library'
import { prisma } from '@/lib/prisma'
import { AVATAR_KV_PREFIX, type ModelAvatar } from '@/lib/tryon/model-avatar'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
} from '@/lib/creative-studio/studio-access'
import {
  assertStudioResourceScope,
  deleteStudioResourceScope,
  readStudioResourceScope,
  studioResourceScopeMatches,
  writeStudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

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
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')?.trim() ?? ''
  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() ?? ''
  let scopedAccess: { ownerId: string; brandProfileId: string; projectId: string } | null = null
  if (brandProfileId || projectId) {
    if (!brandProfileId || !projectId) {
      return Response.json({ error: 'brand_and_project_required' }, { status: 422 })
    }
    const actor = await authenticateStudioRequest(req)
    if (actor instanceof Response) return actor
    try {
      const access = await requireStudioBrandAccess(actor, brandProfileId)
      const project = await db.creativeProject.findFirst({
        where: {
          id: projectId,
          ownerId: access.ownerId,
          brandProfileId,
          archivedAt: null,
        },
        select: { id: true },
      })
      if (!project) throw new StudioAccessError('project_access_forbidden', 403)
      scopedAccess = { ownerId: access.ownerId, brandProfileId, projectId }
    } catch (error) {
      const status = error instanceof StudioAccessError ? error.status : 403
      const code = error instanceof StudioAccessError ? error.code : 'forbidden'
      return Response.json({ error: code }, { status })
    }
  } else {
    const denied = await requireOwner(req)
    if (denied) return denied
  }

  const [allModels, allByRole] = await Promise.all([getModelLibrary(), listModelsByRole()])
  const models = scopedAccess
    ? (await Promise.all(allModels.map(async (model) => ({
        model,
        scope: await readStudioResourceScope('model', model.id),
      }))))
        .filter(({ scope }) => studioResourceScopeMatches(scope, scopedAccess!))
        .map(({ model }) => model)
    : allModels
  const visibleIds = new Set(models.map((model) => model.id))
  const byRole = Object.fromEntries(
    Object.entries(allByRole).filter(([, model]) => model && visibleIds.has(model.id)),
  )

  // The saved model photos live as PRIVATE objects in the agent-files bucket, so
  // the UI can't render them straight from imagePath. Batch-sign every model's
  // image in ONE request and hand back a ready-to-use imageUrl per model — this
  // is what powers the Model Library thumbnails and the visual model picker
  // (previously the library only showed name/role text, so a saved model looked
  // like it "never showed up" after upload).
  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(
      models.map((m) => m.imagePath).filter(Boolean),
      3600,
    )
  } catch {
    signed = {}
  }
  // CS14 — avatar status per model (one batched kv read)
  const avatarByModel: Record<string, { built: boolean; building: boolean; count: number }> = {}
  try {
    const rows = await db.agentKvSetting.findMany({ where: { key: { startsWith: AVATAR_KV_PREFIX } } })
    for (const r of rows as Array<{ key: string; value: string }>) {
      try {
        const a = JSON.parse(r.value) as ModelAvatar
        avatarByModel[r.key.slice(AVATAR_KV_PREFIX.length)] = {
          built: Boolean(a.builtAt),
          building: Boolean(a.building),
          count: Array.isArray(a.imagePaths) ? a.imagePaths.length : 0,
        }
      } catch { /* skip malformed row */ }
    }
  } catch { /* avatar status optional */ }

  const withUrls = models.map((m) => ({
    ...m,
    imageUrl: signed[m.imagePath] ?? null,
    avatar: avatarByModel[m.id] ?? null,
  }))

  return Response.json({ models: withUrls, byRole })
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
    brandProfileId?: string
    projectId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = String(body.action ?? 'add')
  const brandProfileId = String(body.brandProfileId ?? '').trim()
  const projectId = String(body.projectId ?? '').trim()
  if ((brandProfileId || projectId) && (!brandProfileId || !projectId)) {
    return Response.json({ error: 'brand_and_project_required' }, { status: 422 })
  }
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })

  // Wrap all DB work so a real failure returns its actual message as JSON. Without
  // this an exception (e.g. the agent_brand_models table not yet migrated on
  // production) fell through to Next's default 500 HTML page, and the Model
  // Library UI could only show a useless generic "save_failed".
  try {
    if (action === 'remove') {
      const id = String(body.id ?? '').trim().toLowerCase()
      if (brandProfileId && projectId) {
        await assertStudioResourceScope('model', id, {
          ownerId: String(token?.sub ?? ''),
          brandProfileId,
          projectId,
        })
      }
      const ok = await removeBrandModel(id)
      if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
      await deleteStudioResourceScope('model', id)
      return Response.json({ ok: true })
    }

    if (action === 'set_default') {
      if (brandProfileId || projectId) {
        return Response.json({
          error: 'scoped_default_model_unsupported',
          message: 'V3 pins the selected scoped identity per run; the legacy global default is not changed.',
        }, { status: 409 })
      }
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

    let scopedOwnerId: string | null = null
    if (brandProfileId || projectId) {
      const project = await db.creativeProject.findFirst({
        where: {
          id: projectId,
          ownerId: String(token?.sub ?? ''),
          brandProfileId,
          archivedAt: null,
        },
        select: { id: true },
      })
      if (!project) return Response.json({ error: 'project_access_forbidden' }, { status: 403 })
      scopedOwnerId = String(token!.sub)
    }

    if (scopedOwnerId) {
      const conflicts = await db.agentBrandModel.findMany({
        where: { OR: [{ id }, { role }] },
        select: { id: true },
      })
      for (const conflict of conflicts as Array<{ id: string }>) {
        const scope = await readStudioResourceScope('model', conflict.id)
        if (!studioResourceScopeMatches(scope, {
          ownerId: scopedOwnerId,
          brandProfileId,
          projectId,
        })) {
          return Response.json({
            error: 'model_role_or_id_scoped_elsewhere',
            message: 'This identity id/role belongs to another brand project and cannot be replaced.',
          }, { status: 409 })
        }
      }
    }

    const saved = await addBrandModel({
      id,
      name,
      imagePath,
      isDefault: false,
      notes: body.notes ? String(body.notes) : undefined,
      role,
    })
    if (scopedOwnerId) {
      await writeStudioResourceScope('model', saved.id, {
        ownerId: scopedOwnerId,
        brandProfileId,
        projectId,
        createdById: scopedOwnerId,
      })
    }

    return Response.json({ model: saved }, { status: 201 })
  } catch (err) {
    if (err instanceof StudioAccessError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status })
    }
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

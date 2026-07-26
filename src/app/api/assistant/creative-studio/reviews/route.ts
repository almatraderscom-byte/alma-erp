import { type NextRequest } from 'next/server'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  addStudioReviewComment,
  authorizeStudioAssetSpend,
  getStudioReviewThread,
  reviewWorkflowErrorResponse,
} from '@/lib/creative-studio/review-workflow'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrls } from '@/agent/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function reviewError(error: unknown): Response {
  try {
    return reviewWorkflowErrorResponse(error, 'creative-reviews')
  } catch (accessError) {
    return studioAccessErrorResponse(accessError, 'creative-reviews')
  }
}

function decodeQueueCursor(value: string | null): { updatedAt: Date; id: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      updatedAt?: string
      id?: string
    }
    const updatedAt = new Date(String(parsed.updatedAt ?? ''))
    return Number.isFinite(updatedAt.getTime()) && parsed.id
      ? { updatedAt, id: String(parsed.id) }
      : null
  } catch {
    return null
  }
}

function queueCursor(value: { updatedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({
    updatedAt: value.updatedAt.toISOString(),
    id: value.id,
  }), 'utf8').toString('base64url')
}

async function listReviewQueue(
  actor: Exclude<Awaited<ReturnType<typeof authenticateStudioRequest>>, Response>,
  input: {
    brandProfileId: string
    projectId: string | null
    cursor: string | null
    includeApproved: boolean
  },
) {
  const access = await requireStudioBrandAccess(actor, input.brandProfileId)
  const cursor = decodeQueueCursor(input.cursor)
  if (input.cursor && !cursor) throw new StudioAccessError('invalid_review_cursor', 400)
  if (input.projectId) {
    const project = await (prisma as any).creativeProject.findFirst({
      where: {
        id: input.projectId,
        ownerId: access.ownerId,
        brandProfileId: input.brandProfileId,
        archivedAt: null,
      },
      select: { id: true },
    })
    if (!project) throw new StudioAccessError('project_access_forbidden', 403)
  }
  const rows = await (prisma as any).creativeProjectAsset.findMany({
    where: {
      reviewState: {
        in: input.includeApproved
          ? ['DRAFT', 'CHANGES_REQUESTED', 'REVISED', 'APPROVED']
          : ['DRAFT', 'CHANGES_REQUESTED', 'REVISED'],
      },
      versions: { some: {} },
      project: {
        ownerId: access.ownerId,
        brandProfileId: input.brandProfileId,
        archivedAt: null,
        ...(input.projectId ? { id: input.projectId } : {}),
      },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { lt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      projectId: true,
      title: true,
      reviewState: true,
      reviewSequence: true,
      latestStoragePath: true,
      updatedAt: true,
      versions: {
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { id: true, storagePath: true },
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 51,
  }) as Array<{
    id: string
    projectId: string
    title: string | null
    reviewState: 'DRAFT' | 'CHANGES_REQUESTED' | 'REVISED' | 'APPROVED'
    reviewSequence: number
    latestStoragePath: string | null
    updatedAt: Date
    versions: Array<{ id: string; storagePath: string | null }>
  }>
  const page = rows.slice(0, 50)
  const paths = page.flatMap((row) => {
    const path = row.versions[0]?.storagePath ?? row.latestStoragePath
    return path ? [path] : []
  })
  const signed: Record<string, string> = paths.length
    ? await agentStorageSignedUrls(paths, 3600).catch(() => ({}))
    : {}
  const items = page.map((row) => {
    const path = row.versions[0]?.storagePath ?? row.latestStoragePath
    return {
      projectAssetId: row.id,
      projectId: row.projectId,
      brandProfileId: input.brandProfileId,
      currentVersionId: row.versions[0].id,
      expectedSequence: row.reviewSequence,
      state: row.reviewState.toLowerCase(),
      title: row.title,
      previewUrl: path ? signed[path] ?? null : null,
    }
  })
  const last = page.at(-1)
  return {
    items,
    nextCursor: rows.length > 50 && last
      ? queueCursor({ updatedAt: last.updatedAt, id: last.id })
      : null,
  }
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const assetId = req.nextUrl.searchParams.get('assetId') ?? ''
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  if (!assetId) {
    if (!brandProfileId) {
      return Response.json({ error: 'brand_profile_id_required' }, { status: 422 })
    }
    try {
      return Response.json(await listReviewQueue(actor, {
        brandProfileId,
        projectId: req.nextUrl.searchParams.get('projectId'),
        cursor: req.nextUrl.searchParams.get('cursor'),
        includeApproved:
          req.nextUrl.searchParams.get('includeApproved') === 'true',
      }))
    } catch (error) {
      return reviewError(error)
    }
  }
  try {
    return Response.json({
      review: await getStudioReviewThread(actor, assetId, brandProfileId),
    })
  } catch (error) {
    return reviewError(error)
  }
}

export async function POST(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const assetId = typeof body.assetId === 'string' ? body.assetId : ''
  const brandProfileId = typeof body.brandProfileId === 'string'
    ? body.brandProfileId
    : null
  if (!assetId) return Response.json({ error: 'asset_id_required' }, { status: 422 })

  try {
    if (body.intent === 'authorize_spend') {
      return Response.json(await authorizeStudioAssetSpend(actor, {
        assetId,
        brandProfileId,
        estimatedCostBdt: body.estimatedCostBdt,
      }))
    }
    if (body.intent !== 'comment') {
      return Response.json({ error: 'invalid_review_intent' }, { status: 422 })
    }
    return Response.json({
      review: await addStudioReviewComment(actor, {
        assetId,
        brandProfileId,
        body: body.comment,
      }),
    }, { status: 201 })
  } catch (error) {
    return reviewError(error)
  }
}

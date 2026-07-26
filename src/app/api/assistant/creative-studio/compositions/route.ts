import type { NextRequest } from 'next/server'
import {
  authorizeCompositionRoute,
  compositionRouteError,
  compositionRouteJson,
} from '@/lib/creative-studio/composition-route'
import {
  createCreativeComposition,
  getExistingProjectCompositionProjection,
  listCreativeCompositions,
} from '@/lib/creative-studio/composition-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const actor = await authorizeCompositionRoute(req, 'read')
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  const projectId = req.nextUrl.searchParams.get('projectId')
  const includeProjection = req.nextUrl.searchParams.get('projection') === 'readonly'
  if (includeProjection && !projectId) {
    return Response.json({ error: 'project_id_required' }, { status: 422 })
  }
  try {
    const [compositions, projection] = await Promise.all([
      listCreativeCompositions(actor, { brandProfileId, projectId }),
      includeProjection
        ? getExistingProjectCompositionProjection(actor, projectId!, brandProfileId)
        : Promise.resolve(null),
    ])
    return Response.json({
      compositions,
      ...(projection ? { projection } : {}),
      legacyDefault: true,
      legacyFallback: true,
    })
  } catch (error) {
    return compositionRouteError(error, 'creative-compositions-list')
  }
}

export async function POST(req: NextRequest) {
  const actor = await authorizeCompositionRoute(req, 'write')
  if (actor instanceof Response) return actor
  const body = await compositionRouteJson(req)
  if (body instanceof Response) return body
  try {
    const result = await createCreativeComposition(actor, body)
    return Response.json(result, { status: result.idempotent ? 200 : 201 })
  } catch (error) {
    return compositionRouteError(error, 'creative-compositions-create')
  }
}

import type { NextRequest } from 'next/server'
import {
  authorizeCompositionRoute,
  compositionRouteError,
  compositionRouteJson,
} from '@/lib/creative-studio/composition-route'
import { creativeCompositionCommandService } from '@/lib/creative-studio/composition-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const actor = await authorizeCompositionRoute(req, 'write')
  if (actor instanceof Response) return actor
  const body = await compositionRouteJson(req)
  if (body instanceof Response) return body
  try {
    const result = await creativeCompositionCommandService.apply(actor, params.id, body)
    return Response.json(result, { status: result.idempotent ? 200 : 201 })
  } catch (error) {
    return compositionRouteError(error, 'creative-composition-apply')
  }
}

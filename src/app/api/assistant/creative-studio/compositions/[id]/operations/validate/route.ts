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
  const actor = await authorizeCompositionRoute(req, 'plan')
  if (actor instanceof Response) return actor
  const body = await compositionRouteJson(req)
  if (body instanceof Response) return body
  try {
    return Response.json({
      validation: await creativeCompositionCommandService.validate(actor, params.id, body),
    })
  } catch (error) {
    return compositionRouteError(error, 'creative-composition-validate')
  }
}

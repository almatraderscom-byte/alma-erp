import type { NextRequest } from 'next/server'
import {
  authorizeCompositionRoute,
  compositionRouteError,
} from '@/lib/creative-studio/composition-route'
import { getCreativeComposition } from '@/lib/creative-studio/composition-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const actor = await authorizeCompositionRoute(req, 'read')
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  try {
    return Response.json({
      composition: await getCreativeComposition(actor, params.id, brandProfileId),
      legacyDefault: true,
      legacyFallback: true,
    })
  } catch (error) {
    return compositionRouteError(error, 'creative-composition-get')
  }
}

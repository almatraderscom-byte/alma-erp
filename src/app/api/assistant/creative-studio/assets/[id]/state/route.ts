import { type NextRequest } from 'next/server'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  reviewWorkflowErrorResponse,
  transitionStudioAssetReview,
} from '@/lib/creative-studio/review-workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function stateError(error: unknown): Response {
  try {
    return reviewWorkflowErrorResponse(error, 'creative-asset-state')
  } catch (accessError) {
    return studioAccessErrorResponse(accessError, 'creative-asset-state')
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    return Response.json({
      review: await transitionStudioAssetReview(actor, {
        assetId: params.id,
        brandProfileId: typeof body.brandProfileId === 'string'
          ? body.brandProfileId
          : null,
        targetState: body.targetState,
        note: body.note,
        expectedSequence: body.expectedSequence,
        compositionId: body.compositionId,
        compositionVersionId: body.compositionVersionId,
      }),
    })
  } catch (error) {
    return stateError(error)
  }
}

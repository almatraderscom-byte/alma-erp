import type { NextRequest } from 'next/server'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  lifecycleReviewServiceErrorResponse,
  transitionStudioLifecycleReview,
} from '@/lib/creative-studio/lifecycle-review-service'
import {
  reviewWorkflowErrorResponse,
} from '@/lib/creative-studio/review-workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(error: unknown): Response {
  const lifecycle = lifecycleReviewServiceErrorResponse(error)
  if (lifecycle) return lifecycle
  try {
    return reviewWorkflowErrorResponse(error, 'creative-lifecycle-review')
  } catch (accessError) {
    return studioAccessErrorResponse(
      accessError,
      'creative-lifecycle-review',
    )
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
      review: await transitionStudioLifecycleReview(actor, {
        assetId: params.id,
        brandProfileId: body.brandProfileId,
        targetState: body.targetState,
        expectedSequence: body.expectedSequence,
        note: body.note,
        compositionId: body.compositionId,
        compositionVersionId: body.compositionVersionId,
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

import { type NextRequest } from 'next/server'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  addStudioReviewComment,
  authorizeStudioAssetSpend,
  getStudioReviewThread,
  reviewWorkflowErrorResponse,
} from '@/lib/creative-studio/review-workflow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function reviewError(error: unknown): Response {
  try {
    return reviewWorkflowErrorResponse(error, 'creative-reviews')
  } catch (accessError) {
    return studioAccessErrorResponse(accessError, 'creative-reviews')
  }
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const assetId = req.nextUrl.searchParams.get('assetId') ?? ''
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  if (!assetId) return Response.json({ error: 'asset_id_required' }, { status: 422 })
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

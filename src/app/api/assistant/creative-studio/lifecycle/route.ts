import type { NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  createLifecycleJob,
  getLifecycleOperations,
  getLifecycleRolloutDecision,
  lifecycleServiceErrorResponse,
  listLifecycleJobs,
  previewLifecycleJob,
} from '@/lib/creative-studio/lifecycle-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(error: unknown): Response {
  const lifecycle = lifecycleServiceErrorResponse(error, 'creative-lifecycle-api')
  if (lifecycle.status !== 500) return lifecycle
  return studioAccessErrorResponse(error, 'creative-lifecycle-api')
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  const projectId = req.nextUrl.searchParams.get('projectId')
  if (!brandProfileId || !projectId) {
    return Response.json({ error: 'brand_and_project_required' }, { status: 422 })
  }
  const compositionId = req.nextUrl.searchParams.get('compositionId')
  try {
    const [jobs, operations, rollout] = await Promise.all([
      listLifecycleJobs(actor, { brandProfileId, projectId, compositionId }),
      getLifecycleOperations(actor, { brandProfileId, projectId }),
      getLifecycleRolloutDecision(actor, {
        brandProfileId,
        projectId,
        capability: 'preview',
      }),
    ])
    return Response.json({
      jobs,
      operations,
      execution: {
        paidRender: false,
        externalPublish: false,
        legacyFallbackAvailable: rollout.legacyFallbackAvailable,
        legacyFallbackExecution: rollout.fallbackExecution,
      },
      rollout,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    if (body.intent === 'preview') {
      return Response.json({ preview: await previewLifecycleJob(actor, body) })
    }
    if (body.intent === 'queue') {
      const result = await createLifecycleJob(actor, body)
      return Response.json(result, { status: result.idempotent ? 200 : 201 })
    }
    return Response.json({ error: 'invalid_lifecycle_intent' }, { status: 422 })
  } catch (error) {
    return errorResponse(error)
  }
}

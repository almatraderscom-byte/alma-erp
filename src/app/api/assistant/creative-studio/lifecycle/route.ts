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
  resolveLifecycleCompositionPin,
} from '@/lib/creative-studio/lifecycle-service'
import type { StudioLifecycleFlagScope } from '@/lib/creative-studio/lifecycle-rollout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CAPABILITIES = [
  'preview',
  'render',
  'export',
  'dry_run',
  'schedule',
  'live_publish',
] as const satisfies readonly StudioLifecycleFlagScope['capability'][]

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
  const artifactVersionId = req.nextUrl.searchParams.get('artifactVersionId')
  if (artifactVersionId && !compositionId) {
    return Response.json({ error: 'composition_id_required' }, { status: 422 })
  }
  try {
    const [jobs, operations, rolloutEntries, pin] = await Promise.all([
      listLifecycleJobs(actor, { brandProfileId, projectId, compositionId }),
      getLifecycleOperations(actor, { brandProfileId, projectId }),
      Promise.all(CAPABILITIES.map(async (capability) => [
        capability,
        await getLifecycleRolloutDecision(actor, {
          brandProfileId,
          projectId,
          capability,
        }),
      ] as const)),
      compositionId && artifactVersionId
        ? resolveLifecycleCompositionPin(actor, {
            brandProfileId,
            projectId,
            compositionId,
            artifactVersionId,
          })
        : Promise.resolve(null),
    ])
    const rollouts = Object.fromEntries(rolloutEntries) as Record<
      typeof CAPABILITIES[number],
      Awaited<ReturnType<typeof getLifecycleRolloutDecision>>
    >
    const rollout = rollouts.preview
    return Response.json({
      jobs,
      operations,
      execution: {
        paidRender: false,
        voiceProvider: false,
        externalPublish: false,
        localWorkerFlagEnabled:
          process.env.STUDIO_LIFECYCLE_LOCAL_WORKER_ENABLED === 'true',
        legacyFallbackAvailable: rollout.legacyFallbackAvailable,
        legacyFallbackExecution: rollout.fallbackExecution,
      },
      rollout,
      rollouts,
      pin,
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

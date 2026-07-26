import type { NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  configureLifecycleFeatureFlag,
  lifecycleServiceErrorResponse,
  listLifecycleFeatureFlags,
} from '@/lib/creative-studio/lifecycle-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(error: unknown): Response {
  const lifecycle = lifecycleServiceErrorResponse(error, 'creative-lifecycle-flags-api')
  if (lifecycle.status !== 500) return lifecycle
  return studioAccessErrorResponse(error, 'creative-lifecycle-flags-api')
}

function exactScope(req: NextRequest): Record<string, string | null> {
  return {
    brandProfileId: req.nextUrl.searchParams.get('brandProfileId'),
    projectId: req.nextUrl.searchParams.get('projectId'),
    role: req.nextUrl.searchParams.get('role'),
    capability: req.nextUrl.searchParams.get('capability'),
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  try {
    return Response.json({
      flags: await listLifecycleFeatureFlags(actor, exactScope(req)),
      execution: {
        configOnly: true,
        paidRenderAllowed: false,
        voiceProviderAllowed: false,
        externalPublishAllowed: false,
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PUT(req: NextRequest) {
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
    const result = await configureLifecycleFeatureFlag(actor, body)
    return Response.json(result, { status: result.idempotent ? 200 : 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

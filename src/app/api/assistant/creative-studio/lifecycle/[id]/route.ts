import type { NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  controlLifecycleJob,
  lifecycleServiceErrorResponse,
} from '@/lib/creative-studio/lifecycle-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function errorResponse(error: unknown): Response {
  const lifecycle = lifecycleServiceErrorResponse(error, 'creative-lifecycle-control')
  if (lifecycle.status !== 500) return lifecycle
  return studioAccessErrorResponse(error, 'creative-lifecycle-control')
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
    const result = await controlLifecycleJob(actor, {
      ...body,
      jobId: params.id,
    })
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}

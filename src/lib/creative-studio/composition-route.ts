import { Buffer } from 'node:buffer'
import type { NextRequest } from 'next/server'
import {
  authenticateStudioRequest,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  creativeStudioV3FeatureResponse,
} from '@/lib/creative-studio/composition-feature-flags'
import { compositionServiceErrorResponse } from '@/lib/creative-studio/composition-service'

export const CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES = 2 * 1024 * 1024

function compositionRequestTooLarge(actualBytes?: number): Response {
  return Response.json({
    error: 'creative_composition_request_too_large',
    details: {
      ...(actualBytes === undefined ? {} : { actualBytes }),
      maxBytes: CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES,
    },
  }, { status: 413 })
}

export async function authorizeCompositionRoute(
  req: NextRequest,
  capability: 'read' | 'plan' | 'write',
): Promise<StudioActor | Response> {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  return creativeStudioV3FeatureResponse(capability) ?? actor
}

export async function compositionRouteJson(req: NextRequest): Promise<unknown | Response> {
  const declaredBytes = Number(req.headers.get('content-length'))
  if (
    Number.isFinite(declaredBytes)
    && declaredBytes > CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES
  ) {
    return compositionRequestTooLarge(declaredBytes)
  }
  try {
    const raw = await req.text()
    const actualBytes = Buffer.byteLength(raw, 'utf8')
    if (actualBytes > CREATIVE_COMPOSITION_API_REQUEST_MAX_BYTES) {
      return compositionRequestTooLarge(actualBytes)
    }
    return JSON.parse(raw) as unknown
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
}

export function compositionRouteError(error: unknown, event: string): Response {
  return compositionServiceErrorResponse(error, event)
}

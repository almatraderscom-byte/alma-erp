export const CREATIVE_STUDIO_PREVIEW_STATUS = 'preview_approved'
export const CREATIVE_STUDIO_PREVIEW_WORKER_HEADER = 'x-alma-worker-scope'
export const CREATIVE_STUDIO_PREVIEW_WORKER_SCOPE = 'creative-studio-preview'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function isVercelPreviewRuntime(): boolean {
  return process.env.VERCEL_ENV === 'preview'
}

export function isSignedCreativeStudioImagePayload(payload: unknown): boolean {
  const value = object(payload)
  const authorization = object(value.studioRunAuthorization)
  return value.creativeStudio === true
    && typeof authorization.receipt === 'string'
    && authorization.receipt.length > 0
}

export function creativeStudioImageQueueStatus(payload: unknown): 'approved' | 'preview_approved' {
  return isVercelPreviewRuntime() && isSignedCreativeStudioImagePayload(payload)
    ? CREATIVE_STUDIO_PREVIEW_STATUS
    : 'approved'
}

export function isAuthorizedPreviewWorkerRequest(req: Request): boolean {
  return isVercelPreviewRuntime()
    && req.headers.get(CREATIVE_STUDIO_PREVIEW_WORKER_HEADER) === CREATIVE_STUDIO_PREVIEW_WORKER_SCOPE
}

export function isPreviewApprovedCreativeStudioImageAction(action: {
  status?: unknown
  type?: unknown
  payload?: unknown
}): boolean {
  return isVercelPreviewRuntime()
    && action.status === CREATIVE_STUDIO_PREVIEW_STATUS
    && action.type === 'image_gen'
    && isSignedCreativeStudioImagePayload(action.payload)
}

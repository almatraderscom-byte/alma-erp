export const PREVIEW_WORKER_SCOPE_HEADER = 'x-alma-worker-scope'
export const PREVIEW_WORKER_SCOPE = 'creative-studio-preview'

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function selectPreviewImageJob(jobs, projectId) {
  const expectedProjectId = String(projectId ?? '').trim()
  if (!expectedProjectId || !Array.isArray(jobs)) return null
  return jobs.find((job) => {
    const payload = object(job?.payload)
    const scope = object(payload.studioRunScope)
    const authorization = object(payload.studioRunAuthorization)
    return job?.type === 'image_gen'
      // Internal chain artifacts hide from Gallery with creativeStudio=false,
      // but remain signed Studio V3 jobs and belong to the same isolated run.
      && payload.studioSurface === 'v3'
      && scope.projectId === expectedProjectId
      && typeof authorization.receipt === 'string'
      && authorization.receipt.length > 0
  }) ?? null
}

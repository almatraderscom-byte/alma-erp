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
      && payload.creativeStudio === true
      && scope.projectId === expectedProjectId
      && typeof authorization.receipt === 'string'
      && authorization.receipt.length > 0
  }) ?? null
}

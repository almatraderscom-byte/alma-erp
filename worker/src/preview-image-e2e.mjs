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

/** Certification is stricter than the ordinary production worker: a terminal
 * Studio chain artifact that exhausted strict QC is an E2E failure even though
 * the callback is technically successful and deliberately keeps the best
 * flagged image for review. Intermediate steps may fail QC and still improve
 * downstream, so only the terminal step closes the release gate. */
export function terminalPreviewImageQcFailure(payload, reportedResult) {
  const familyChain = object(payload?.familyChain)
  const plan = Array.isArray(familyChain.plan) ? familyChain.plan : []
  const stepIndex = Number(familyChain.stepIndex)
  const terminal = plan.length === 0
    || (Number.isInteger(stepIndex) && stepIndex === plan.length - 1)
  if (!terminal) return null

  const qc = object(reportedResult?.data?.qc)
  if (qc.pass !== false) return null
  const overall = Number.isFinite(Number(qc.overall)) ? Number(qc.overall) : 0
  const flagged = typeof qc.flagged === 'string' && qc.flagged.trim()
    ? qc.flagged.trim()
    : 'strict QC failed'
  return `preview_image_qc_failed:${overall}/5:${flagged}`
}

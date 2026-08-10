/** Normalizes the worker's backward-compatible single/multi-image result. */
export function imageResultPaths(data: Record<string, unknown> | undefined): string[] {
  if (!data) return []
  const candidates: unknown[] = []
  if (Array.isArray(data.images)) {
    for (const image of data.images) {
      if (image && typeof image === 'object') candidates.push((image as { storagePath?: unknown }).storagePath)
    }
  }
  if (Array.isArray(data.storagePaths)) candidates.push(...data.storagePaths)
  candidates.push(data.storagePath)

  const seen = new Set<string>()
  const paths: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const path = candidate.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
    if (paths.length === 4) break
  }
  return paths
}

/** Owner-visible QC warnings for every delivered variation, not only image 1. */
export function imageResultQcWarnings(data: Record<string, unknown> | undefined): string[] {
  if (!data) return []
  const variationQc = Array.isArray(data.variationQc) ? data.variationQc : null
  const qcRows = variationQc ?? [data.qc]
  const warnings: string[] = []
  const seen = new Set<string>()
  if (typeof data.partialWarning === 'string' && data.partialWarning.trim()) {
    const warning = data.partialWarning.trim()
    seen.add(warning)
    warnings.push(warning)
  }
  qcRows.forEach((qc, index) => {
    if (!qc || typeof qc !== 'object') return
    const flagged = (qc as { flagged?: unknown }).flagged
    if (typeof flagged !== 'string' || !flagged.trim()) return
    const warning = variationQc ? `Image ${index + 1}: ${flagged.trim()}` : flagged.trim()
    if (seen.has(warning)) return
    seen.add(warning)
    warnings.push(warning)
  })
  return warnings
}

export interface SignedImagePreview {
  path: string
  url: string
  index: number
}

/** File refs are the durable delivery. Signed Markdown URLs are best-effort
 * previews and one signing outage must never erase the rest of a paid batch. */
export async function signImageResultPreviews(
  paths: string[],
  sign: (path: string) => Promise<string>,
): Promise<{ previews: SignedImagePreview[]; failedPaths: string[] }> {
  const settled = await Promise.allSettled(paths.map((path) => sign(path)))
  const previews: SignedImagePreview[] = []
  const failedPaths: string[] = []
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) {
      previews.push({ path: paths[index], url: result.value, index })
    } else {
      failedPaths.push(paths[index])
    }
  })
  return { previews, failedPaths }
}

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

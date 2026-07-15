/** Pure URL extraction for successful live-browser evidence. */
export function extractClientSeoBrowserEvidenceUrl(
  input: Record<string, unknown>,
  data: unknown,
): string {
  const d = (data ?? {}) as Record<string, unknown>
  const page = (d.page ?? {}) as Record<string, unknown>
  const candidates = [d.currentUrl, page.url, d.url, input.url]
  return candidates.find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)) ?? ''
}

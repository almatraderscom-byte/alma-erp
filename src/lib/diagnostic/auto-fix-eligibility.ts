/**
 * Which health-scan issues may spawn Cursor Auto-Fix (code/infra bugs only).
 * Business/data issues (website stock, price drift) stay in health scan + agent
 * tools — never Auto-Fix Telegram cards.
 *
 * Keep in sync with worker/src/auto-fix/eligibility.mjs
 */
export type AutoFixIssueLike = {
  area?: string
  signal?: string
}

export function isAutoFixEligible(issue: AutoFixIssueLike): boolean {
  const area = String(issue.area ?? '').toLowerCase()
  const signal = String(issue.signal ?? '').toLowerCase()

  // Website/catalog/inventory parity — owner/agent data action, not a code PR
  if (area === 'website') return false
  if (signal.startsWith('website:')) return false

  // Informational backlog — not code defects
  if (area === 'cost' || area === 'approvals') return false

  return true
}

export function autoFixIneligibleReason(issue: AutoFixIssueLike): string | null {
  if (isAutoFixEligible(issue)) return null
  const area = String(issue.area ?? '').toLowerCase()
  if (area === 'website') {
    return 'Website/inventory alerts use agent tools (unpublish/sync), not Cursor Auto-Fix.'
  }
  return 'This issue type is not eligible for Cursor Auto-Fix.'
}

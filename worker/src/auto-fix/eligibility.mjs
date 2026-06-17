/**
 * Auto-Fix eligibility — code/infra only. Sync with src/lib/diagnostic/auto-fix-eligibility.ts
 */
export function isAutoFixEligible(issue) {
  const area = String(issue?.area ?? '').toLowerCase()
  const signal = String(issue?.signal ?? '').toLowerCase()

  if (area === 'website') return false
  if (signal.startsWith('website:')) return false
  if (area === 'cost' || area === 'approvals') return false

  return true
}

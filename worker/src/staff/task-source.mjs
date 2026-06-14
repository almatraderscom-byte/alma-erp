/** Map task source to DB-allowed values: rotation | pattern | owner | agent */
export function normalizeStaffTaskSource(source) {
  const s = String(source ?? 'agent')
  if (s === 'curriculum' || s === 'owner_decision' || s === 'carry_forward' || s === 'website_pattern') return 'pattern'
  if (s === 'rotation' || s === 'pattern' || s === 'owner' || s === 'agent') return s
  return 'agent'
}

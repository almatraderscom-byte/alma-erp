/** Browser-only — reads session identity for authenticated-feeling audit trails (trusted via API_SECRET server-side). */
export function readActorHeadersFromStorage(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const name = (sessionStorage.getItem('alma-actor-name') || 'Operator').trim().slice(0, 120)
    const role = (sessionStorage.getItem('alma-actor-role') || 'SUPER_ADMIN').trim().slice(0, 48)
    return {
      'X-Alma-Actor': name || 'Operator',
      'X-Alma-Role': role || 'SUPER_ADMIN',
    }
  } catch {
    return { 'X-Alma-Actor': 'Operator', 'X-Alma-Role': 'SUPER_ADMIN' }
  }
}

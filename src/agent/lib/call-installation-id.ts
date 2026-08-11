/** Shared native installation-id contract for call delivery and call ownership. */
export const CALL_INSTALLATION_ID_MAX_LENGTH = 180

export function normalizeCallInstallationId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const installationId = value.trim()
  if (installationId.length < 1 || installationId.length > CALL_INSTALLATION_ID_MAX_LENGTH) return null
  // Current iOS ids are UUIDs; Android also uses opaque URL-safe ids. Keeping
  // control characters and whitespace out makes the value safe for ownership
  // telemetry, database predicates, and future structured logs.
  return /^[A-Za-z0-9._:-]+$/.test(installationId) ? installationId : null
}

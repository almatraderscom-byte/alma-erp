export const STUDIO_WEB_VERSION_COOKIE = 'alma-creative-studio-web-version'
export const STUDIO_WEB_VERSION_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60

export type StudioWebVersion = 'v4' | 'legacy'

export function normalizeStudioWebVersion(
  value: string | null | undefined,
): StudioWebVersion | null {
  return value === 'v4' || value === 'legacy' ? value : null
}

export function resolveStudioWebVersionPreference(
  explicitVersion: string | null | undefined,
  storedVersion: string | null | undefined,
): StudioWebVersion | null {
  return normalizeStudioWebVersion(explicitVersion)
    ?? normalizeStudioWebVersion(storedVersion)
}

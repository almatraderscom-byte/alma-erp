/** Client-visible build id — compared against /api/health for stale PWA detection. */
export const APP_BUILD_ID =
  process.env.NEXT_PUBLIC_APP_BUILD_ID
  || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT
  || 'dev'

export const RUNTIME_BUILD_STORAGE_KEY = 'alma_app_build_id'

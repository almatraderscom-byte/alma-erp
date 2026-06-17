/** Client-visible build id — compared against /api/health for stale PWA detection. */
export const APP_BUILD_ID =
  process.env.NEXT_PUBLIC_APP_BUILD_ID
  || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT
  || 'dev'

export const RUNTIME_BUILD_STORAGE_KEY = 'alma_app_build_id'

const GITHUB_REPO = 'almatraderscom-byte/alma-erp'

export type BuildInfo = {
  ok: true
  environment: string
  commit: string | null
  commitShort: string | null
  message: string | null
  branch: string | null
  appUrl: string
  githubCommitUrl: string | null
  vercelDeploymentUrl: string | null
  checkedAt: string
}

function readCommitSha(): string | null {
  const raw =
    process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT
    || ''
  const trimmed = raw.trim()
  return trimmed || null
}

/** Server-side build metadata (Vercel injects git vars at build time). */
export function getBuildInfo(): BuildInfo {
  const commit = readCommitSha()
  const commitShort = commit ? commit.slice(0, 7) : null
  const messageRaw = process.env.VERCEL_GIT_COMMIT_MESSAGE?.trim() || ''
  const message = messageRaw ? messageRaw.split('\n')[0] : null
  const branch = process.env.VERCEL_GIT_COMMIT_REF?.trim() || null
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown'
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim()
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
    || 'https://alma-erp-six.vercel.app'

  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim() || null
  const vercelDeploymentUrl = deploymentId
    ? `https://vercel.com/deployments/${deploymentId}`
    : null

  return {
    ok: true,
    environment,
    commit,
    commitShort,
    message,
    branch,
    appUrl,
    githubCommitUrl: commit ? `https://github.com/${GITHUB_REPO}/commit/${commit}` : null,
    vercelDeploymentUrl,
    checkedAt: new Date().toISOString(),
  }
}

export function formatBuildLabel(info: Pick<BuildInfo, 'environment' | 'commitShort'>): string {
  const env = info.environment === 'production' ? 'prod' : info.environment
  const sha = info.commitShort ?? 'local'
  return `${env} · ${sha}`
}

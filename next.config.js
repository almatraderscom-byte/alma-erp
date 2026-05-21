/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['@react-pdf/renderer'] },
  poweredByHeader: false,
  compress: true,
  env: {
    /** Surfaced by /api/health + optional client reads */
    NEXT_PUBLIC_VERCEL_GIT_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA || '',
    NEXT_PUBLIC_APP_BUILD_ID:
      process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT
      || process.env.npm_package_version
      || 'local',
  },
  async redirects() {
    return [{ source: '/digital/finance', destination: '/finance', permanent: false }]
  },
}

const { withSentryConfig } = require('@sentry/nextjs')

const sentryBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: true,
  tunnelRoute: '/monitoring',
}

module.exports =
  process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
    ? withSentryConfig(nextConfig, sentryBuildOptions)
    : nextConfig

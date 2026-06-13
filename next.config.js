/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['@react-pdf/renderer'] },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: '**.googleusercontent.com' },
      { protocol: 'https', hostname: 'drive.google.com' },
    ],
  },
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
  NEXT_PUBLIC_ANDROID_APK_URL: process.env.NEXT_PUBLIC_ANDROID_APK_URL || '',
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'https://alma-erp-six.vercel.app',
  },
  async redirects() {
    return [
      { source: '/digital/finance', destination: '/finance', permanent: false },
      { source: '/app/download', destination: '/download.html', permanent: false },
    ]
  },
  async headers() {
    return [
      {
        source: '/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|OneSignalSDKWorker.js|OneSignalSDKUpdaterWorker.js|offline.html|download.html|fonts/|releases/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|apk|html)$).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
      {
        source: '/releases/:file*.apk',
        headers: [
          {
            key: 'Content-Disposition',
            value: 'attachment; filename="alma-erp.apk"',
          },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      {
        source: '/download.html',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
    ]
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

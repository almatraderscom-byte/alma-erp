/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer', 'bullmq', 'ioredis', 'puppeteer-core', '@sparticuz/chromium'],
    // CRITICAL: static `public/` assets are CDN-served and are NOT included in the
    // serverless function filesystem by default. The brand/Bangla TTFs are read from
    // disk at runtime (sharp/librsvg only renders text with fonts fontconfig finds on
    // disk — it ignores embedded @font-face data URIs). Without tracing them into the
    // Lambda, every server-side SVG text render (Creative Studio finishing, ad
    // creatives, brand frames) comes out BLANK on Vercel. Force-include the fonts for
    // every route that renders branded images.
    outputFileTracingIncludes: {
      '/api/assistant/creative-studio/finish': ['./public/fonts/**'],
      '/api/assistant/creative-studio/branding': ['./public/fonts/**'],
      '/api/assistant/creative-studio/run': ['./public/fonts/**'],
      '/api/assistant/brand-models': ['./public/fonts/**'],
      '/api/assistant/brand-models/tryon': ['./public/fonts/**'],
      '/api/assistant/internal/ad-creative-gate': ['./public/fonts/**'],
      // Client-report PDF (2026-07-16): Bangla TTFs for the report template.
      // NOTE: do NOT try to trace @sparticuz/chromium/bin here — local
      // nft.json picks it up but Vercel's bundler still drops it; the route
      // downloads the browser pack remotely instead (see the route file).
      '/api/assistant/artifacts/[id]/pdf': ['./public/fonts/**'],
      // Skill Engine V2: the SKILL.md packages are read from disk at runtime by
      // skill-engine/runtime.ts. Without tracing them into the chat lambda, Vercel
      // drops the source `.md`/`.json` and discovery silently finds nothing.
      '/api/assistant/chat': ['./src/agent/skills/**'],
    },
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.supabase.co' },
      { protocol: 'https', hostname: '**.googleusercontent.com' },
      { protocol: 'https', hostname: 'drive.google.com' },
    ],
  },
  poweredByHeader: false,
  // 2026-07-16 build-hang fix: `next build`'s combined "Linting and checking
  // validity of types" stage intermittently deadlocks on Vercel's 4-core box
  // (three 30-45m hung deploys on 2026-07-15/16, one of them production, all
  // wedged at exactly this stage; the same commit + same restored cache also
  // built in 4-6m, so it is a worker hang, not our code). Correctness moved to
  // CI: the Agent PR Gate runs `tsc --noEmit` + `next lint` on every PR, so
  // the deploy build only builds. Do NOT remove without re-checking the hang.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
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

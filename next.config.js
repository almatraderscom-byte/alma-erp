/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['@react-pdf/renderer'] },
  poweredByHeader: false,
  compress: true,
  env: {
    /** Surfaced by /api/health + optional client reads */
    NEXT_PUBLIC_VERCEL_GIT_COMMIT: process.env.VERCEL_GIT_COMMIT_SHA || '',
  },
  async redirects() {
    return [{ source: '/digital/finance', destination: '/finance', permanent: false }]
  },
}
module.exports = nextConfig

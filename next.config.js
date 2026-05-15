/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { serverComponentsExternalPackages: ['@react-pdf/renderer'] },
  async redirects() {
    return [{ source: '/digital/finance', destination: '/finance', permanent: false }]
  },
}
module.exports = nextConfig

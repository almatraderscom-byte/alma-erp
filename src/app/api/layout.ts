/** All API route handlers require runtime auth/env — never static prerender at build. */
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default function ApiSegmentLayout({ children }: { children: React.ReactNode }) {
  return children
}

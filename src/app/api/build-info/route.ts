import { NextResponse } from 'next/server'
import { getBuildInfo } from '@/lib/runtime-build'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Lightweight deploy fingerprint — bookmark:
 * https://alma-erp-six.vercel.app/api/build-info
 */
export async function GET() {
  return NextResponse.json(getBuildInfo(), {
    headers: { 'Cache-Control': 'public, no-store, max-age=0' },
  })
}

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { requireRoles } from '@/lib/api-guards'
import { fetchSmsBalance } from '@/lib/sms/provider'

export async function GET(req: NextRequest) {
  const denied = await requireRoles(req, ['SUPER_ADMIN', 'ADMIN'])
  if (denied) return denied
  const balance = await fetchSmsBalance()
  return NextResponse.json(balance, { headers: { 'Cache-Control': 'private, no-store' } })
}

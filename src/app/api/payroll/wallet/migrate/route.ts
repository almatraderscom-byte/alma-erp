import { NextRequest, NextResponse } from 'next/server'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'
import { migrateLegacyApprovedAdvances } from '@/lib/payroll-ledger-migration'

export async function POST(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (ctx.role !== 'SUPER_ADMIN' && ctx.role !== 'ADMIN' && ctx.role !== 'HR') {
    return forbidden('Only HR/Admin can run ledger migration.')
  }
  const result = await migrateLegacyApprovedAdvances()
  return NextResponse.json(result)
}

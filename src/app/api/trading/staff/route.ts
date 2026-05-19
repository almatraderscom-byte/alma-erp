import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { TRADING_BUSINESS_ID, getTradingContext, requireTradingAdmin } from '@/lib/trading'

export async function GET(req: NextRequest) {
  const ctx = await getTradingContext(req)
  if ('error' in ctx) return ctx.error
  const adminDenied = requireTradingAdmin(ctx)
  if (adminDenied) return adminDenied

  const staff = await prisma.user.findMany({
    where: {
      active: true,
      businessAccess: { contains: TRADING_BUSINESS_ID },
      role: { in: ['ADMIN', 'HR', 'STAFF'] },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true, phone: true, role: true, employeeIdGas: true, salaryHint: true },
  })
  return NextResponse.json({ staff }, { headers: { 'Cache-Control': 'private, no-store' } })
}

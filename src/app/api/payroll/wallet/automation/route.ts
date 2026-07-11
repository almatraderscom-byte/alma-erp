import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext, forbidden } from '@/lib/payroll-wallet-access'

export async function GET(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can view automation settings.')

  const setting = await prisma.payrollAutomationSetting.upsert({
    where: { id: 'global' },
    update: {},
    create: { id: 'global' },
  })
  return NextResponse.json({ setting })
}

export async function PATCH(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  if (!ctx.isAdmin) return forbidden('Only HR/Admin can update automation settings.')

  const body = (await req.json()) as Partial<{
    enabled: boolean
    dayOfMonth: number
    timezone: string
    retryAfterMinutes: number
    notifyAdminsOnFailure: boolean
    heldBusinessIds: string[]
  }>
  const VALID_BUSINESS = new Set(['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT', 'ALMA_TRADING'])
  const held = body.heldBusinessIds === undefined
    ? undefined
    : [...new Set(body.heldBusinessIds.map(String).filter(b => VALID_BUSINESS.has(b)))]
  const day = body.dayOfMonth === undefined ? undefined : Math.min(28, Math.max(1, Number(body.dayOfMonth)))
  const setting = await prisma.payrollAutomationSetting.upsert({
    where: { id: 'global' },
    update: {
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(day !== undefined ? { dayOfMonth: day } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone || 'Asia/Dhaka' } : {}),
      ...(body.retryAfterMinutes !== undefined ? { retryAfterMinutes: Math.max(5, Number(body.retryAfterMinutes)) } : {}),
      ...(body.notifyAdminsOnFailure !== undefined ? { notifyAdminsOnFailure: body.notifyAdminsOnFailure } : {}),
      ...(held !== undefined ? { heldBusinessIds: held } : {}),
      updatedById: ctx.userId,
    },
    create: {
      id: 'global',
      enabled: body.enabled ?? true,
      dayOfMonth: day ?? 10,
      timezone: body.timezone || 'Asia/Dhaka',
      retryAfterMinutes: body.retryAfterMinutes ?? 60,
      notifyAdminsOnFailure: body.notifyAdminsOnFailure ?? true,
      heldBusinessIds: held ?? [],
      updatedById: ctx.userId,
    },
  })
  return NextResponse.json({ ok: true, setting })
}

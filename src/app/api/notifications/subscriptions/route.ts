import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'

export async function POST(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  const body = (await req.json()) as {
    provider?: string
    playerId?: string
    endpoint?: string
    externalUserId?: string
    businessId?: string
    role?: string
    employeeIdGas?: string | null
    platform?: string
    userAgent?: string
    enabled?: boolean
  }
  const provider = body.provider || 'onesignal'
  if (!body.playerId && !body.endpoint) {
    return NextResponse.json({ error: 'playerId or endpoint required' }, { status: 400 })
  }
  const businessId = body.businessId && ctx.businessIds.map(String).includes(body.businessId)
    ? body.businessId
    : ctx.businessIds[0]
  const employeeIdGas = ctx.isSystemOwner ? null : body.employeeIdGas || ctx.employeeId || null
  const now = new Date()
  const sub = await prisma.pushSubscription.upsert({
    where: {
      provider_playerId: {
        provider,
        playerId: body.playerId || body.endpoint || ctx.userId,
      },
    },
    update: {
      userId: ctx.userId,
      endpoint: body.endpoint || null,
      externalUserId: body.externalUserId || ctx.userId,
      businessId,
      role: body.role || ctx.role,
      employeeIdGas,
      platform: body.platform || null,
      userAgent: body.userAgent ? body.userAgent.slice(0, 500) : null,
      enabled: body.enabled ?? true,
      lastSeenAt: now,
    },
    create: {
      userId: ctx.userId,
      provider,
      playerId: body.playerId || body.endpoint || ctx.userId,
      endpoint: body.endpoint || null,
      externalUserId: body.externalUserId || ctx.userId,
      businessId,
      role: body.role || ctx.role,
      employeeIdGas,
      platform: body.platform || null,
      userAgent: body.userAgent ? body.userAgent.slice(0, 500) : null,
      enabled: body.enabled ?? true,
      lastSeenAt: now,
    },
  })
  return NextResponse.json({ ok: true, subscription: sub })
}

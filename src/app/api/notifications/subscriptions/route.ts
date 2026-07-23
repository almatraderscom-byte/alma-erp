import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'

const recentCalls = new Map<string, number>()
const RATE_WINDOW_MS = 60_000
const MAX_PER_WINDOW = 5

export async function POST(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error

  const uid = ctx.userId
  const ts = Date.now()
  const last = recentCalls.get(uid) ?? 0
  if (ts - last < RATE_WINDOW_MS / MAX_PER_WINDOW) {
    return NextResponse.json({ error: 'rate_limited', retry_after: 12 }, { status: 429 })
  }
  recentCalls.set(uid, ts)
  if (recentCalls.size > 5000) {
    const cutoff = ts - RATE_WINDOW_MS
    for (const [k, v] of recentCalls) if (v < cutoff) recentCalls.delete(k)
  }
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
      externalUserId: ctx.userId,
      businessId,
      // Identity/role come from the authenticated session, never client JSON.
      // A staff device must not be able to tag/register itself as an admin.
      role: ctx.role,
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
      externalUserId: ctx.userId,
      businessId,
      role: ctx.role,
      employeeIdGas,
      platform: body.platform || null,
      userAgent: body.userAgent ? body.userAgent.slice(0, 500) : null,
      enabled: body.enabled ?? true,
      lastSeenAt: now,
    },
  })
  return NextResponse.json({ ok: true, subscription: sub })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getWalletContext } from '@/lib/payroll-wallet-access'

export async function POST(req: NextRequest) {
  const ctx = await getWalletContext(req)
  if ('error' in ctx) return ctx.error
  const body = (await req.json()) as { provider?: string; playerId?: string; endpoint?: string; platform?: string; enabled?: boolean }
  const provider = body.provider || 'onesignal'
  if (!body.playerId && !body.endpoint) {
    return NextResponse.json({ error: 'playerId or endpoint required' }, { status: 400 })
  }
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
      platform: body.platform || null,
      enabled: body.enabled ?? true,
    },
    create: {
      userId: ctx.userId,
      provider,
      playerId: body.playerId || body.endpoint || ctx.userId,
      endpoint: body.endpoint || null,
      platform: body.platform || null,
      enabled: body.enabled ?? true,
    },
  })
  return NextResponse.json({ ok: true, subscription: sub })
}

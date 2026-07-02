// Register/disable the Imou event webhook (owner-only). POST {enable: true}
// tells Imou's cloud to push alarm events (motion/human) for the developer
// account to our /api/assistant/internal/imou-event receiver, carrying the
// KV imou_webhook_key as ?k= so the receiver can authenticate pushes.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { setImouMessageCallback } from '@/agent/lib/imou-camera'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const PROD_BASE = 'https://alma-erp-six.vercel.app'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let enable = true
  try {
    const body = (await req.json()) as { enable?: boolean }
    enable = body.enable !== false
  } catch { /* default: enable */ }

  try {
    let callbackUrl: string | undefined
    if (enable) {
      const row = await db.agentKvSetting.findUnique({
        where: { key: 'imou_webhook_key' }, select: { value: true },
      })
      const key = ((row?.value as string | undefined) ?? '').trim()
      if (!key) {
        return NextResponse.json(
          { error: 'imou_webhook_key KV সেট করা নেই — আগে token বানিয়ে নিন।' },
          { status: 400 },
        )
      }
      callbackUrl = `${PROD_BASE}/api/assistant/internal/imou-event?k=${key}`
    }
    await setImouMessageCallback({ enable, callbackUrl, callbackFlag: 'alarm' })
    return NextResponse.json({ ok: true, enabled: enable, callbackUrl: enable ? callbackUrl : null })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'setMessageCallback failed' },
      { status: 500 },
    )
  }
}

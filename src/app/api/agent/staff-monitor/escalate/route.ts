import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body?.staffName || !body?.messageType) {
    return Response.json({ error: 'staffName and messageType required' }, { status: 400 })
  }

  const { staffName, messageType, outboxId } = body as {
    staffName: string
    messageType: string
    outboxId?: string
  }

  try {
    const result = await notifyOwner({
      tier: 2,
      title: `⚠️ ${staffName} — মেসেজ দেখেননি`,
      message: `${staffName} ১০+ মিনিট ধরে "${messageType}" মেসেজ দেখেননি। Manual follow-up needed.\n\nOutbox: ${outboxId ?? 'N/A'}`,
      category: 'urgent',
    })

    return Response.json({ ok: true, ...result })
  } catch (err) {
    console.error('[staff-monitor/escalate]', err)
    return Response.json({
      error: 'escalation_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 })
  }
}

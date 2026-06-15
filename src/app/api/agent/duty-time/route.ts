import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const KV_PREFIX = 'duty.time.'

function dhakaToCronUtc(dhakaTime: string): string | null {
  const match = dhakaTime.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  let h = parseInt(match[1], 10)
  const m = parseInt(match[2], 10)
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  // Dhaka is UTC+6
  h = (h - 6 + 24) % 24
  return `${m} ${h} * * *`
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const rows = await prisma.agentKvSetting.findMany({
    where: { key: { startsWith: KV_PREFIX } },
  })
  const overrides: Record<string, string> = {}
  for (const r of rows) {
    overrides[r.key.replace(KV_PREFIX, '')] = r.value
  }
  return Response.json({ overrides })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as { dutyKey?: string; time?: string }
  const { dutyKey, time } = body
  if (!dutyKey || !time) {
    return Response.json({ error: 'dutyKey and time (HH:MM) required' }, { status: 400 })
  }

  const cronUtc = dhakaToCronUtc(time)
  if (!cronUtc) {
    return Response.json({ error: 'Invalid time format. Use HH:MM (00:00-23:59)' }, { status: 400 })
  }

  const key = `${KV_PREFIX}${dutyKey}`
  await prisma.agentKvSetting.upsert({
    where: { key },
    update: { value: JSON.stringify({ dhakaTime: time, cronUtc, updatedAt: new Date().toISOString() }) },
    create: { key, value: JSON.stringify({ dhakaTime: time, cronUtc, updatedAt: new Date().toISOString() }) },
  })

  await prisma.agentKvSetting.upsert({
    where: { key: 'duty.time._changed' },
    update: { value: new Date().toISOString() },
    create: { key: 'duty.time._changed', value: new Date().toISOString() },
  })

  return Response.json({ ok: true, dutyKey, dhakaTime: time, cronUtc })
}

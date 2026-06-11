import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { BUDGET_KEYS, getBudgetSettings } from '@/agent/lib/cost-events'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  return Response.json(await getBudgetSettings())
}

export async function PUT(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { dailyUsd?: number | null; monthlyUsd?: number | null }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const upserts: Promise<unknown>[] = []

  if (body.dailyUsd !== undefined) {
    if (body.dailyUsd === null) {
      upserts.push(db.agentKvSetting.deleteMany({ where: { key: BUDGET_KEYS.dailyUsd } }))
    } else {
      upserts.push(db.agentKvSetting.upsert({
        where: { key: BUDGET_KEYS.dailyUsd },
        create: { key: BUDGET_KEYS.dailyUsd, value: String(body.dailyUsd) },
        update: { value: String(body.dailyUsd) },
      }))
    }
  }
  if (body.monthlyUsd !== undefined) {
    if (body.monthlyUsd === null) {
      upserts.push(db.agentKvSetting.deleteMany({ where: { key: BUDGET_KEYS.monthlyUsd } }))
    } else {
      upserts.push(db.agentKvSetting.upsert({
        where: { key: BUDGET_KEYS.monthlyUsd },
        create: { key: BUDGET_KEYS.monthlyUsd, value: String(body.monthlyUsd) },
        update: { value: String(body.monthlyUsd) },
      }))
    }
  }

  await Promise.all(upserts)
  return Response.json(await getBudgetSettings())
}

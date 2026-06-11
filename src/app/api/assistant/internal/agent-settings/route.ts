/**
 * GET  /api/assistant/internal/agent-settings?keys=k1,k2  → read settings
 * POST /api/assistant/internal/agent-settings              → upsert { key, value }
 * Internal token auth only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const keys = req.nextUrl.searchParams.get('keys')
  const keyList = keys ? keys.split(',').map((k: string) => k.trim()).filter(Boolean) : null

  const rows = await db.agentKvSetting.findMany({
    where: keyList ? { key: { in: keyList } } : undefined,
  })

  const result: Record<string, string> = {}
  for (const r of rows) result[r.key] = r.value

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { key, value } = body as { key?: string; value?: string }

  if (!key || value === undefined) {
    return NextResponse.json({ error: 'key and value required' }, { status: 400 })
  }

  await db.agentKvSetting.upsert({
    where:  { key },
    update: { value },
    create: { key, value },
  })

  return NextResponse.json({ ok: true, key, value })
}

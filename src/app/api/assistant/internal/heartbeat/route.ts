/**
 * POST /api/assistant/internal/heartbeat — worker upserts service heartbeats.
 * Body: { service: string } or { services: string[] }
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

const ALLOWED = new Set(['telegram-bot', 'schedulers', 'queue-consumer', 'app-health'])

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { service?: string; services?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const names = body.services?.length
    ? body.services
    : body.service
      ? [body.service]
      : []

  const services = names.filter((s) => typeof s === 'string' && ALLOWED.has(s))
  if (services.length === 0) {
    return NextResponse.json({ error: 'service or services required' }, { status: 400 })
  }

  const now = new Date()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  await Promise.all(
    services.map((service) =>
      db.agentHeartbeat.upsert({
        where: { service },
        create: { service, lastBeatAt: now },
        update: { lastBeatAt: now },
      }),
    ),
  )

  return NextResponse.json({ ok: true, services, at: now.toISOString() })
}

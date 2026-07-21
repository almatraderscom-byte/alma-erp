// Camera LISTENER controls (owner-only, website-facing).
//
// Lets the owner turn the entrance-camera voice listener on/off and tune its
// daily STT cap straight from the ERP website — no redeploy, no KV console.
// Backs the same agent_kv_settings keys the /internal/camera-listen route reads,
// so a flip here takes effect on the very next audio chunk.
//
//   GET  → { enabled, dailyCap, usedToday, wakeWords, echoGuardSec }
//   POST { enabled?, dailyCap? } → upsert + return the fresh status
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const maxDuration = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DEFAULT_WAKE_WORDS = 'আলমা শোনো'
const DEFAULT_DAILY_STT_CAP = 400

async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function kvSet(key: string, value: string): Promise<void> {
  await db.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

async function status() {
  const dayKey = `camera_listen_stt_count:${new Date().toISOString().slice(0, 10)}`
  const [enabledRaw, capRaw, wakeRaw, usedRaw, echoRaw] = await Promise.all([
    kvGet('camera_listen_enabled'),
    kvGet('camera_listen_daily_cap'),
    kvGet('camera_wake_words'),
    kvGet(dayKey),
    kvGet('camera_listen_echo_guard_sec'),
  ])
  return {
    enabled: (enabledRaw ?? 'off').toLowerCase() === 'on',
    dailyCap: Number(capRaw ?? DEFAULT_DAILY_STT_CAP) || DEFAULT_DAILY_STT_CAP,
    usedToday: Number(usedRaw ?? 0) || 0,
    wakeWords: (wakeRaw ?? DEFAULT_WAKE_WORDS).trim(),
    echoGuardSec: Number(echoRaw ?? 60) || 60,
  }
}

async function requireOwner(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions)
  if (!session?.user || !isSystemOwner(session)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET() {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const forbidden = await requireOwner()
  if (forbidden) return forbidden
  return NextResponse.json({ ok: true, ...(await status()) })
}

interface ControlBody {
  enabled?: boolean
  dailyCap?: number
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const forbidden = await requireOwner()
  if (forbidden) return forbidden

  let body: ControlBody
  try {
    body = (await req.json()) as ControlBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (body.enabled !== undefined) {
    await kvSet('camera_listen_enabled', body.enabled ? 'on' : 'off')
  }
  if (body.dailyCap !== undefined && Number.isFinite(body.dailyCap) && body.dailyCap > 0) {
    await kvSet('camera_listen_daily_cap', String(Math.round(body.dailyCap)))
  }

  return NextResponse.json({ ok: true, ...(await status()) })
}

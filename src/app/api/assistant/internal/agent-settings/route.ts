/**
 * GET  /api/assistant/internal/agent-settings?keys=k1,k2  → read settings
 * POST /api/assistant/internal/agent-settings              → upsert { key, value }
 * Internal token auth only. POST keys are allowlisted.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

const EXACT_KEYS = new Set([
  'cs_mode',
  'cs_followups_enabled',
  'salah_escalation_level',
  'staff_task_profiles',
  'today_sales_summary',
  'worker.lastDeploy',
  'content_engine_enabled',
  'content_engine_slots',
  'owner_call_lock_until',
  // Camera listener controls — so the owner can re-enable / tune it without a
  // redeploy after the runaway-cost fix (default is now OFF).
  'camera_listen_enabled',
  'camera_wake_words',
  'camera_listen_cooldown_sec',
  'camera_listen_stt_prompt',
  'camera_listen_daily_cap',
  'camera_listen_echo_guard_sec',
])

const PREFIX_KEYS = [
  'budget.alert.',
  'balance.alert.',
  'worker.',
  'proof_requests:',
  'idle_alert:',
  'vercel.alert.',
  'personal_snooze:',
  'model.routing.',
]

const MAX_VALUE_CHARS = 32_000

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

function isAllowedKey(key: string): boolean {
  if (!key || key.length > 120) return false
  if (EXACT_KEYS.has(key)) return true
  return PREFIX_KEYS.some((p) => key.startsWith(p))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const keys = req.nextUrl.searchParams.get('keys')
  const keyList = keys ? keys.split(',').map((k: string) => k.trim()).filter(Boolean) : null
  if (keyList?.some((k) => !isAllowedKey(k))) {
    return NextResponse.json({ error: 'key_not_allowed' }, { status: 403 })
  }

  const rows = await db.agentKvSetting.findMany({
    where: keyList ? { key: { in: keyList } } : undefined,
  })

  const result: Record<string, string> = {}
  for (const r of rows) {
    if (isAllowedKey(r.key)) result[r.key] = r.value
  }

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { key, value } = body as { key?: string; value?: string }

  if (!key || value === undefined) {
    return NextResponse.json({ error: 'key and value required' }, { status: 400 })
  }
  if (!isAllowedKey(key)) {
    return NextResponse.json({ error: 'key_not_allowed' }, { status: 403 })
  }
  if (String(value).length > MAX_VALUE_CHARS) {
    return NextResponse.json({ error: 'value_too_large' }, { status: 400 })
  }

  await db.agentKvSetting.upsert({
    where:  { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  })

  return NextResponse.json({ ok: true, key, value })
}

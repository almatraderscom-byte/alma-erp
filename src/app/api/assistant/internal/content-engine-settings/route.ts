/**
 * GET/POST /api/assistant/internal/content-engine-settings
 * Owner Telegram menu — autonomous prep on/off + status (internal token only).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import {
  getContentEngineConfig,
  setContentEngineEnabled,
} from '@/lib/content-engine/config'
import { countPendingContentApprovals } from '@/lib/content-engine/pipeline'

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

const SLOTS_BN = ['১০:০০', '১৫:০০', '১৯:০০']

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const config = await getContentEngineConfig()
  const pendingApprovals = await countPendingContentApprovals()

  return NextResponse.json({
    enabled: config.enabled,
    perDay: config.perDay,
    maxPending: config.maxPendingApprovals,
    pendingApprovals,
    slotsDhaka: SLOTS_BN.slice(0, config.perDay),
    note: 'Autonomous prep only — publishing still needs Gate 1 + Gate 2 approvals.',
  })
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { enabled?: boolean; action?: string }
  let enabled: boolean | undefined
  if (typeof body.enabled === 'boolean') {
    enabled = body.enabled
  } else if (body.action === 'on' || body.action === 'enable') {
    enabled = true
  } else if (body.action === 'off' || body.action === 'disable') {
    enabled = false
  }

  if (enabled === undefined) {
    return NextResponse.json({ error: 'enabled or action required' }, { status: 400 })
  }

  await setContentEngineEnabled(enabled)
  const config = await getContentEngineConfig()
  const pendingApprovals = await countPendingContentApprovals()

  return NextResponse.json({
    ok: true,
    enabled: config.enabled,
    perDay: config.perDay,
    pendingApprovals,
    message: enabled
      ? `✅ অটো প্রেপ চালু — দিনে ${config.perDay} স্লট (${SLOTS_BN.slice(0, config.perDay).join(', ')} Dhaka)`
      : '⏸ অটো প্রেপ বন্ধ — নতুন পোস্ট প্রেপ হবে না (আগের approval গুলো আছে)',
  })
}

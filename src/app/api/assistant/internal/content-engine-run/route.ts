/**
 * POST /api/assistant/internal/content-engine-run
 * Autonomous content prep — picks product, runs pipeline to Gate 1 (never publishes).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { pickNextProduct } from '@/lib/content-engine/pick-product'
import { getContentEngineConfig } from '@/lib/content-engine/config'
import { resolveTheme } from '@/lib/content-engine/theme'
import {
  startContentPipeline,
  countPendingContentApprovals,
  loadProductAsset,
} from '@/lib/content-engine/pipeline'

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

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { slot?: number; productCode?: string; skipGuards?: boolean }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const slot = Number(body.slot ?? 1)
  const config = await getContentEngineConfig()

  if (!config.enabled) {
    return NextResponse.json({ skipped: true, reason: 'content_engine_disabled' })
  }

  if (slot > config.perDay) {
    return NextResponse.json({
      skipped: true,
      reason: `slot_${slot}_above_per_day_${config.perDay}`,
    })
  }

  if (!body.skipGuards) {
    const pending = await countPendingContentApprovals()
    if (pending >= config.maxPendingApprovals) {
      return NextResponse.json({
        skipped: true,
        reason: `pending_approvals_${pending}`,
        pending,
      })
    }
  }

  let productCode = body.productCode?.trim()
  if (!productCode) {
    const picked = await pickNextProduct({ minDaysBetween: config.minDaysBetweenPosts })
    if (!picked.ok) {
      return NextResponse.json({ skipped: true, reason: picked.reason })
    }
    productCode = picked.product.productCode
  } else {
    const asset = await loadProductAsset(productCode)
    if (!asset) {
      return NextResponse.json({ skipped: true, reason: 'product_not_found' })
    }
  }

  const resolvedTheme = await resolveTheme()
  const result = await startContentPipeline({
    productCode,
    autonomousSlot: slot,
    resolvedTheme,
  })

  return NextResponse.json({
    ok: true,
    skipped: false,
    slot,
    productCode: result.productCode,
    gate1Id: result.gate1Id,
    pipelineId: result.pipelineId,
    variants: result.variants,
    theme: resolvedTheme.label,
    hook: resolvedTheme.hook,
    message: `Gate 1 prep queued for ${result.productCode} (slot ${slot})`,
  })
}

/**
 * POST /api/assistant/internal/content-gate1-variant
 * Per-variant keep toggle or draft regeneration at Gate 1.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import {
  toggleGate1VariantKeep,
  regenerateGate1Variant,
} from '@/lib/content-engine/pipeline'
import type { ContentVariant } from '@/lib/content-engine/generate-variants'

export const runtime = 'nodejs'

const VALID_VARIANTS = new Set(['single', 'father_son', 'mother_son', 'full_family'])

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

  let body: { gate1Id?: string; variant?: string; action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const gate1Id = String(body.gate1Id ?? '').trim()
  const variant = String(body.variant ?? '').trim() as ContentVariant
  const action = String(body.action ?? '').trim()

  if (!gate1Id || !VALID_VARIANTS.has(variant)) {
    return NextResponse.json({ error: 'gate1Id and valid variant required' }, { status: 400 })
  }

  try {
    if (action === 'keep') {
      const result = await toggleGate1VariantKeep(gate1Id, variant)
      return NextResponse.json({
        success: true,
        keep: result.keep,
        summary: result.summary,
        keyboard: result.keyboard,
      })
    }
    if (action === 'regenerate') {
      const result = await regenerateGate1Variant(gate1Id, variant)
      return NextResponse.json({
        success: true,
        queued: result.queued,
        summary: result.summary,
      })
    }
    return NextResponse.json({ error: 'action must be keep or regenerate' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}

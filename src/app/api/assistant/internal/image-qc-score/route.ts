/**
 * POST /api/assistant/internal/image-qc-score
 * Worker calls after image generation — returns QC rubric scores.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  scoreCreativeQCFromPath,
  getQcLevel,
  evaluateQCScore,
  type QCScore,
} from '@/lib/tryon/qc-gate'
import { SURFACE_THRESHOLDS, evaluateSurfaceScore, type StudioSurface } from '@/lib/creative-studio/eval-types'

export const runtime = 'nodejs'
export const maxDuration = 60

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
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    storagePath?: string
    productType?: string
    productImagePath?: string
    /** CS10 — surface-specific thresholds (single_tryon/family/precision_edit/…) */
    surface?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const storagePath = String(body.storagePath ?? '').trim()
  if (!storagePath) return NextResponse.json({ error: 'storagePath required' }, { status: 400 })

  try {
    const level = await getQcLevel()
    if (level === 'off') {
      const bypass: QCScore = {
        garment_fidelity: 5,
        model_preserved: 5,
        anatomy: 5,
        brand_consistency: 5,
        text_legibility: 5,
        composition: 5,
        overall: 5,
        fail_reasons: [],
        fix_hint: '',
      }
      return NextResponse.json({ level, pass: true, score: bypass, bypassed: true })
    }

    const score = await scoreCreativeQCFromPath({
      storagePath,
      productType: body.productType ?? null,
      productImagePath: body.productImagePath ?? null,
    })
    // CS10 — surface-specific thresholds when the caller names a surface;
    // legacy level-based pass otherwise (backward compatible).
    const surface = body.surface && body.surface in SURFACE_THRESHOLDS ? (body.surface as StudioSurface) : null
    const pass = surface ? evaluateSurfaceScore(score, surface) : evaluateQCScore(score, level)
    return NextResponse.json({ level, pass, score, surface: surface ?? undefined })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

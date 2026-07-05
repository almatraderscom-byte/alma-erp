// Phase V1: the VPS worker detects scene changes with ffmpeg, then asks THIS
// endpoint for the deterministic cut plan — so the recipe parameters and the
// planner algorithm live in exactly one place (src/lib/creative-studio/
// video-recipes.ts, unit-tested). Authenticated with AGENT_INTERNAL_TOKEN.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { getVideoRecipe, planCuts, VIDEO_ASPECTS } from '@/lib/creative-studio/video-recipes'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { recipeId?: string; durationSec?: number; sceneChanges?: number[]; targetSec?: number; aspect?: string }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const recipe = getVideoRecipe(String(body.recipeId ?? ''))
  if (!recipe) return Response.json({ error: 'invalid_recipe' }, { status: 422 })

  const durationSec = Number(body.durationSec)
  const targetSec = Number(body.targetSec)
  const sceneChanges = Array.isArray(body.sceneChanges) ? body.sceneChanges.map(Number) : []
  if (!Number.isFinite(durationSec) || !Number.isFinite(targetSec)) {
    return Response.json({ error: 'invalid_input' }, { status: 422 })
  }

  const aspectDef = VIDEO_ASPECTS.find((a) => a.id === body.aspect) ?? VIDEO_ASPECTS[0]

  try {
    const plan = planCuts({ recipe, durationSec, sceneChanges, targetSec })
    return Response.json({
      ok: true,
      plan,
      output: { width: aspectDef.width, height: aspectDef.height, aspect: aspectDef.id, fps: 30 },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 422 })
  }
}

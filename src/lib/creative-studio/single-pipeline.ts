/**
 * CS8 — professional single-person production pipeline.
 *
 * Deterministic policy layer (owner's no-LLM-creative-judgment rule):
 *  - PREVIEW mode: one economical paid generation, no auto repair, QC scores
 *    for information only;
 *  - PRODUCTION mode: strict QC with HARD core-axis gates (garment fidelity,
 *    model identity, anatomy each ≥4/5 — overall alone can no longer pass),
 *    bounded regens, and NO automatic face/embroidery repair: when the best
 *    attempt still fails, the flagged artifact is returned with a one-tap
 *    masked-rescue path (owner paints the mask; FLUX Fill repairs only that).
 *
 * Also: input readiness gate (stop unusable inputs BEFORE money is spent) and
 * controlled scene diversity (no near-identical batch variants).
 */
import { prisma } from '@/lib/prisma'
import { agentStorageDownload } from '@/agent/lib/storage'
import { logCost } from '@/agent/lib/cost-events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type PipelineMode = 'preview' | 'production'

export const CS_PIPELINE_MODE_KEY = 'cs_pipeline_mode'

export function normalizePipelineMode(value: string | null | undefined): PipelineMode {
  return value === 'production' ? 'production' : 'preview'
}

export async function readPipelineMode(): Promise<PipelineMode> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: CS_PIPELINE_MODE_KEY } })
    return normalizePipelineMode(row?.value)
  } catch {
    return 'preview'
  }
}

/** Bounded spend plan per mode — shown to the owner before/after the run. */
export type RunPlan = {
  mode: PipelineMode
  /** hard ceiling on PAID generations (initial + QC regens) for ONE image slot */
  maxPaidGenerations: number
  /** economical generation settings for preview */
  economical: boolean
  /** production only: strict per-axis QC gate applies */
  strictAxisGate: boolean
  /** Bangla one-liner for the UI */
  labelBn: string
}

export function buildRunPlan(mode: PipelineMode): RunPlan {
  if (mode === 'production') {
    return {
      mode,
      maxPaidGenerations: 3, // 1 initial + up to 2 QC regens (existing bound)
      economical: false,
      strictAxisGate: true,
      labelBn: 'প্রোডাকশন — কড়া QC (গার্মেন্ট/মুখ/হাত প্রতিটা ≥৪/৫), সর্বোচ্চ ৩টি পেইড রান',
    }
  }
  return {
    mode,
    maxPaidGenerations: 1,
    economical: true,
    strictAxisGate: false,
    labelBn: 'প্রিভিউ — ১টি সাশ্রয়ী রান, অটো-রিপেয়ার নেই',
  }
}

// ── production hard axis gate (mirrored in worker/src/image-qc.mjs) ──────────

export const PRODUCTION_MIN_CORE_AXIS = 4
export const PRODUCTION_CORE_AXES = ['garment_fidelity', 'model_preserved', 'anatomy'] as const

export function productionAxesPass(score: Partial<Record<string, number>>): boolean {
  return PRODUCTION_CORE_AXES.every((axis) => Number(score[axis] ?? 0) >= PRODUCTION_MIN_CORE_AXIS)
}

/**
 * Which failing axes are SAFE to fix with a narrowly-masked FLUX Fill repair.
 * Owner rule: never auto-repaint faces (model_preserved) or embroidery
 * (garment_fidelity) — those need human judgment; anatomy/hands and
 * composition/background are maskable.
 */
export function repairableAxes(score: Partial<Record<string, number>>): string[] {
  const out: string[] = []
  if (Number(score.anatomy ?? 5) < PRODUCTION_MIN_CORE_AXIS) out.push('anatomy')
  if (Number(score.composition ?? 5) < PRODUCTION_MIN_CORE_AXIS) out.push('composition')
  return out
}

// ── input readiness gate ─────────────────────────────────────────────────────

export type InputReadiness = {
  ok: boolean
  /** machine codes for the run route's Bangla map */
  errors: string[]
  /** soft warnings — run proceeds, owner sees them in the queue message */
  warnings: string[]
}

export const READINESS_ERRORS_BN: Record<string, string> = {
  model_resolution_low: 'মডেলের ছবির রেজোলিউশন খুব কম (ছোট দিক ৫১২px-এর নিচে) — বড়/পরিষ্কার ছবি দিন।',
  product_resolution_low: 'Product ছবির রেজোলিউশন খুব কম — সাপ্লায়ারের বড় ছবিটা দিন।',
  person_not_fully_visible: 'মডেলের পুরো শরীর দেখা যাচ্ছে না — মাথা থেকে পা পর্যন্ত দেখা যায় এমন ছবি দিন।',
  garment_cropped: 'Product ছবিতে গার্মেন্ট কাটা পড়েছে — পুরো গার্মেন্ট দেখা যায় এমন ছবি দিন।',
  image_unreadable: 'ছবিটা পড়া যাচ্ছে না — অন্য ফরম্যাটে আবার upload করুন।',
}

export const READINESS_WARNINGS_BN: Record<string, string> = {
  background_cluttered: 'মডেলের ছবির ব্যাকগ্রাউন্ড ঘিঞ্জি — ফল একটু খারাপ হতে পারে',
  pose_occlusion_risk: 'হাত/ব্যাগ শরীর ঢেকে রেখেছে — গার্মেন্ট বসানো কঠিন হতে পারে',
}

const MIN_MODEL_SIDE = 512
const MIN_PRODUCT_SIDE = 400
const READINESS_CACHE_PREFIX = 'cs_input_readiness:'
const READINESS_VISION_MODEL = 'gemini-2.0-flash'

async function imageMinSide(path: string): Promise<number | null> {
  try {
    const buf = await agentStorageDownload(path)
    const sharp = (await import('sharp')).default
    const meta = await sharp(buf).rotate().metadata()
    if (!meta.width || !meta.height) return null
    return Math.min(meta.width, meta.height)
  } catch {
    return null
  }
}

type VisionReadiness = {
  fullPersonVisible: boolean
  garmentFullyVisible: boolean
  backgroundClutter: 'low' | 'medium' | 'high'
  occlusionRisk: boolean
}

/** Narrow mechanical vision check (cached per model-image path, FAIL-OPEN). */
async function visionReadiness(modelImagePath: string): Promise<VisionReadiness | null> {
  const cacheKey = `${READINESS_CACHE_PREFIX}${modelImagePath}`
  try {
    const cached = await db.agentKvSetting.findUnique({ where: { key: cacheKey } })
    if (cached?.value) return JSON.parse(cached.value) as VisionReadiness
  } catch { /* cache miss */ }

  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  try {
    const buf = await agentStorageDownload(modelImagePath)
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${READINESS_VISION_MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: 'Assess this photo of a PERSON for virtual try-on readiness. STRICT JSON only: {"fullPersonVisible": bool (head to at least mid-thigh visible), "garmentFullyVisible": bool, "backgroundClutter": "low"|"medium"|"high", "occlusionRisk": bool (arms/bag/object covering torso)}',
              },
              { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 128 },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!res.ok) return null
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Partial<VisionReadiness>
    const result: VisionReadiness = {
      fullPersonVisible: parsed.fullPersonVisible !== false,
      garmentFullyVisible: parsed.garmentFullyVisible !== false,
      backgroundClutter: parsed.backgroundClutter === 'high' ? 'high' : parsed.backgroundClutter === 'medium' ? 'medium' : 'low',
      occlusionRisk: parsed.occlusionRisk === true,
    }
    void logCost({
      provider: 'gemini',
      kind: 'cs_vision',
      units: { model: READINESS_VISION_MODEL, purpose: 'input_readiness' },
      costUsd: 0.0001,
      dedupKey: `readiness:${modelImagePath}`,
    })
    try {
      await db.agentKvSetting.upsert({
        where: { key: cacheKey },
        create: { key: cacheKey, value: JSON.stringify(result) },
        update: { value: JSON.stringify(result) },
      })
    } catch { /* cache write best-effort */ }
    return result
  } catch {
    return null // FAIL-OPEN: a dead vision API must never block a run
  }
}

/**
 * Gate unusable inputs BEFORE any paid generation. Hard errors block with a
 * clear Bangla correction; soft signals become warnings on the queue message.
 */
export async function checkSingleInputReadiness(args: {
  modelImagePath: string
  productImagePath: string
}): Promise<InputReadiness> {
  const errors: string[] = []
  const warnings: string[] = []

  const [modelSide, productSide] = await Promise.all([
    imageMinSide(args.modelImagePath),
    imageMinSide(args.productImagePath),
  ])
  if (modelSide === null) errors.push('image_unreadable')
  else if (modelSide < MIN_MODEL_SIDE) errors.push('model_resolution_low')
  if (productSide !== null && productSide < MIN_PRODUCT_SIDE) errors.push('product_resolution_low')

  if (errors.length === 0) {
    const vision = await visionReadiness(args.modelImagePath)
    if (vision) {
      if (!vision.fullPersonVisible) errors.push('person_not_fully_visible')
      if (vision.backgroundClutter === 'high') warnings.push('background_cluttered')
      if (vision.occlusionRisk) warnings.push('pose_occlusion_risk')
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ── controlled scene diversity ───────────────────────────────────────────────

export const RECENT_SCENES_KEY = 'cs_recent_scenes'
export const RECENT_SCENES_WINDOW = 4

export async function readRecentSceneIds(): Promise<string[]> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: RECENT_SCENES_KEY } })
    const parsed = row?.value ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed.map(String).slice(0, RECENT_SCENES_WINDOW) : []
  } catch {
    return []
  }
}

export async function recordSceneUse(sceneId: string): Promise<void> {
  try {
    const recent = await readRecentSceneIds()
    const next = [sceneId, ...recent.filter((s) => s !== sceneId)].slice(0, RECENT_SCENES_WINDOW)
    await db.agentKvSetting.upsert({
      where: { key: RECENT_SCENES_KEY },
      create: { key: RECENT_SCENES_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    })
  } catch { /* best-effort */ }
}

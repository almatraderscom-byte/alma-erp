/**
 * Designer QC gate — vision rubric, pass/fail, bounded regenerate (File 16).
 */
import { agentStorageDownload } from '@/agent/lib/storage'
import { logCost } from '@/agent/lib/cost-events'
import { prisma } from '@/lib/prisma'
import { getDesignPlaybookLines } from '@/agent/lib/taste/distill'
import { getTopReferences, buildReferencePromptBlock } from '@/agent/lib/reference/library'

export const MAX_REGEN = 2

export type QCLevel = 'off' | 'normal' | 'strict'

export type QCScore = {
  garment_fidelity: number
  model_preserved: number
  anatomy: number
  brand_consistency: number
  text_legibility: number
  composition: number
  overall: number
  fail_reasons: string[]
  fix_hint: string
}

export type QCGateConfig = {
  passOverall: number
  minAxis: number
  maxRegen: number
}

const QC_KV_KEY = 'agent_qc_level'

// Keep QC on the same current multimodal generation as the other Studio
// vision gates. The previous 2.5 call had no JSON response contract and let
// partial/empty output collapse every missing axis to a fabricated 3/5.
export const QC_VISION_MODEL = 'gemini-3.6-flash'

export function getQcConfig(level: QCLevel): QCGateConfig {
  switch (level) {
    case 'off':
      return { passOverall: 0, minAxis: 0, maxRegen: 0 }
    case 'strict':
      return { passOverall: 4, minAxis: 3, maxRegen: MAX_REGEN }
    default:
      return { passOverall: 4, minAxis: 2, maxRegen: MAX_REGEN }
  }
}

export async function getQcLevel(): Promise<QCLevel> {
  try {
    const row = await prisma.agentKvSetting.findUnique({ where: { key: QC_KV_KEY } })
    const v = row?.value?.trim().toLowerCase()
    if (v === 'off' || v === 'strict' || v === 'normal') return v
  } catch (err) {
    console.warn('[qc-gate] KV setting read failed:', err instanceof Error ? err.message : err)
  }
  return 'normal'
}

/** Signed production policy always wins over the mutable global QC switch. */
export function resolveQcLevel(configured: QCLevel, pipelineMode?: string): QCLevel {
  return pipelineMode === 'production' ? 'strict' : configured
}

export async function setQcLevel(level: QCLevel): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: QC_KV_KEY },
    create: { key: QC_KV_KEY, value: level },
    update: { value: level },
  })
}

function axisValues(score: QCScore): number[] {
  return [
    score.garment_fidelity,
    score.model_preserved,
    score.anatomy,
    score.brand_consistency,
    score.text_legibility,
    score.composition,
  ]
}

export function evaluateQCScore(score: QCScore, level: QCLevel): boolean {
  if (level === 'off') return true
  const cfg = getQcConfig(level)
  if (score.overall < cfg.passOverall) return false
  return axisValues(score).every((n) => n >= cfg.minAxis)
}

/**
 * CS8 — PRODUCTION-mode hard gate (fixes the audit finding "normal QC can
 * accept a 2/5 individual axis when overall passes"): garment fidelity, model
 * identity and anatomy must EACH be ≥4/5, regardless of overall. Mirrored in
 * worker/src/image-qc.mjs (keep in sync).
 */
export const PRODUCTION_MIN_CORE_AXIS = 4

export function evaluateProductionCoreAxes(score: QCScore): boolean {
  return (
    score.garment_fidelity >= PRODUCTION_MIN_CORE_AXIS
    && score.model_preserved >= PRODUCTION_MIN_CORE_AXIS
    && score.anatomy >= PRODUCTION_MIN_CORE_AXIS
  )
}

export function pickWeakestAxis(score: QCScore): string {
  const axes: Array<[string, number]> = [
    ['garment fidelity', score.garment_fidelity],
    ['model preserved', score.model_preserved],
    ['anatomy', score.anatomy],
    ['brand consistency', score.brand_consistency],
    ['text legibility', score.text_legibility],
    ['composition', score.composition],
  ]
  axes.sort((a, b) => a[1] - b[1])
  return axes[0]?.[0] ?? 'quality'
}

export function buildQcFlagMessage(attemptCount: number, score: QCScore, pass: boolean): string | undefined {
  if (pass && attemptCount <= 1) return undefined
  if (pass) return `QC: passed on attempt ${attemptCount}`
  const weak = pickWeakestAxis(score)
  return `QC: best of ${attemptCount} — weak ${weak} (overall ${score.overall}/5)`
}

async function buildRubricContext(productType?: string | null): Promise<string> {
  const [playbook, refs] = await Promise.all([
    getDesignPlaybookLines(),
    getTopReferences(productType ?? 'panjabi', 3),
  ])
  const refBlock = buildReferencePromptBlock(refs)
  const brandRules = [
    'ALMA Lifestyle — premium Bangladesh ethnic fashion; garment is hero; natural South Asian model; no Western studio clichés.',
    ...playbook.slice(0, 8),
  ]
  return `Brand rules + active taste:\n${brandRules.join('\n')}\n${refBlock}`
}

function buildQcPrompt(rubricContext: string, hasProductReference: boolean, hasPersonReference: boolean): string {
  return `You are comparing ordered fashion images. Score IMAGE 1 (GENERATED OUTPUT) from 1-5 on each axis.
${hasProductReference ? 'IMAGE 2 is the ORIGINAL PRODUCT REFERENCE. Use it only for garment fidelity.' : 'No product reference is supplied; do not invent a garment-fidelity comparison.'}
${hasPersonReference ? `IMAGE ${hasProductReference ? '3' : '2'} is the ORIGINAL PERSON REFERENCE. Use it only for identity/model preservation.` : 'No person reference is supplied; do not invent an identity comparison.'}
Return JSON only with every field present:
{
  "garment_fidelity": n,
  "model_preserved": n,
  "anatomy": n,
  "brand_consistency": n,
  "text_legibility": n,
  "composition": n,
  "overall": n,
  "fail_reasons": ["specific actionable issues"],
  "fix_hint": "what to change in regeneration prompt"
}
text_legibility MUST be numeric; use 5 when there is no overlay text (never return the string "N/A").
Garment fidelity is strict reference matching: color, fabric, cut, length, collar, buttons, embroidery/motif pattern and placement must match the product reference; a redesign is a failure.
Model preservation is strict reference matching: face, age, skin tone, hair and body must match the person reference. Any newly invented tattoo, body art, scar, jewelry, watch, accessory or skin marking that is absent from the person reference is an automatic model_preserved failure (score at most 2) and must be named in fail_reasons.
Anatomy includes natural hands/fingers/limbs and appropriate skin coverage; distorted or newly decorated hands/arms fail this axis.
Do not assign a neutral/default score because an image is difficult to compare. Name the exact visible evidence in fail_reasons and make scores differ when the evidence differs.
${rubricContext}`
}

const QC_NUMERIC_AXES = [
  'garment_fidelity',
  'model_preserved',
  'anatomy',
  'brand_consistency',
  'composition',
  'overall',
] as const

/** Strict parser: an incomplete model response is unavailable QC, never 3/5. */
export function parseQcScoreResponse(rawText: string): QCScore {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('qc_invalid_json:no_object')
  const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  const normalizedTextLegibility = typeof raw.text_legibility === 'string'
    && /^(n\/?a|not applicable)$/i.test(raw.text_legibility.trim())
    ? 5
    : raw.text_legibility
  const clamp = (n: unknown, axis: string) => {
    const v = Number(n)
    if (!Number.isFinite(v)) throw new Error(`qc_invalid_score:${axis}`)
    return Math.min(5, Math.max(1, Math.round(v)))
  }
  for (const axis of QC_NUMERIC_AXES) clamp(raw[axis], axis)
  const fail_reasons = Array.isArray(raw.fail_reasons)
    ? raw.fail_reasons.map(String).slice(0, 6)
    : []
  return {
    garment_fidelity: clamp(raw.garment_fidelity, 'garment_fidelity'),
    model_preserved: clamp(raw.model_preserved, 'model_preserved'),
    anatomy: clamp(raw.anatomy, 'anatomy'),
    brand_consistency: clamp(raw.brand_consistency, 'brand_consistency'),
    // The rubric defines text as N/A=5 when there is no overlay. Gemini may
    // omit only this N/A field; core/product/identity axes remain mandatory.
    text_legibility: clamp(normalizedTextLegibility ?? 5, 'text_legibility'),
    composition: clamp(raw.composition, 'composition'),
    overall: clamp(raw.overall, 'overall'),
    fail_reasons,
    fix_hint: String(raw.fix_hint ?? fail_reasons[0] ?? 'Improve garment fidelity and natural anatomy.').slice(0, 400),
  }
}

export async function scoreCreativeQC(args: {
  imageBase64: string
  mimeType: string
  productType?: string | null
  productImageBase64?: string | null
  productMimeType?: string
  personImageBase64?: string | null
  personMimeType?: string
}): Promise<QCScore> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const rubricContext = await buildRubricContext(args.productType)
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
    { text: buildQcPrompt(rubricContext, Boolean(args.productImageBase64), Boolean(args.personImageBase64)) },
    { text: 'IMAGE 1 — GENERATED OUTPUT TO SCORE:' },
    { inline_data: { mime_type: args.mimeType, data: args.imageBase64 } },
  ]
  if (args.productImageBase64) {
    parts.push({
      text: 'IMAGE 2 — ORIGINAL PRODUCT REFERENCE (garment comparison only):',
    })
    parts.push({
      inline_data: {
        mime_type: args.productMimeType ?? 'image/jpeg',
        data: args.productImageBase64,
      },
    })
  }
  if (args.personImageBase64) {
    parts.push({
      text: `IMAGE ${args.productImageBase64 ? '3' : '2'} — ORIGINAL PERSON REFERENCE (identity comparison only):`,
    })
    parts.push({
      inline_data: {
        mime_type: args.personMimeType ?? 'image/jpeg',
        data: args.personImageBase64,
      },
    })
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${QC_VISION_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1_536,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`QC vision HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const rawText = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
  const score = parseQcScoreResponse(rawText)

  void logCost({
    provider: 'gemini',
    kind: 'qc_vision',
    units: {
      model: QC_VISION_MODEL,
      overall: score.overall,
      garment_fidelity: score.garment_fidelity,
      anatomy: score.anatomy,
      composition: score.composition,
    },
    costUsd: 0.00015,
    dedupKey: `qc:${args.imageBase64.slice(0, 24)}:${Date.now()}`,
  })

  return score
}

export async function scoreCreativeQCFromPath(args: {
  storagePath: string
  productType?: string | null
  productImagePath?: string | null
  personImagePath?: string | null
}): Promise<QCScore> {
  const buf = await agentStorageDownload(args.storagePath)
  const mime = args.storagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'

  let productImageBase64: string | null = null
  let productMimeType = 'image/jpeg'
  if (args.productImagePath) {
    try {
      const pbuf = await agentStorageDownload(args.productImagePath)
      productImageBase64 = pbuf.toString('base64')
      productMimeType = args.productImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    } catch (err) {
      throw new Error(`qc_product_reference_unavailable:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  let personImageBase64: string | null = null
  let personMimeType = 'image/jpeg'
  if (args.personImagePath) {
    try {
      const personBuf = await agentStorageDownload(args.personImagePath)
      personImageBase64 = personBuf.toString('base64')
      personMimeType = args.personImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    } catch (err) {
      throw new Error(`qc_person_reference_unavailable:${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return scoreCreativeQC({
    imageBase64: buf.toString('base64'),
    mimeType: mime,
    productType: args.productType,
    productImageBase64,
    productMimeType,
    personImageBase64,
    personMimeType,
  })
}

export type QCAttempt = {
  storagePath: string
  score: QCScore
  pass: boolean
  attempt: number
}

export async function runQCGateOnAttempts(args: {
  level: QCLevel
  scoreFn: (storagePath: string) => Promise<QCScore>
  regenerate: (fixHint: string, attempt: number) => Promise<string>
  initialPath: string
}): Promise<{ best: QCAttempt; attempts: QCAttempt[]; flagged?: string }> {
  const cfg = getQcConfig(args.level)
  const attempts: QCAttempt[] = []

  let currentPath = args.initialPath
  const maxGenerations = args.level === 'off' ? 1 : cfg.maxRegen + 1

  for (let i = 0; i < maxGenerations; i++) {
    const score = args.level === 'off'
      ? parseQcScoreResponse(JSON.stringify({ overall: 5, garment_fidelity: 5, model_preserved: 5, anatomy: 5, brand_consistency: 5, text_legibility: 5, composition: 5, fail_reasons: [], fix_hint: '' }))
      : await args.scoreFn(currentPath)
    const pass = evaluateQCScore(score, args.level)
    attempts.push({ storagePath: currentPath, score, pass, attempt: i + 1 })

    if (pass || args.level === 'off') break
    if (i >= cfg.maxRegen) break

    currentPath = await args.regenerate(score.fix_hint, i + 2)
  }

  const best = attempts.reduce((a, b) => (b.score.overall > a.score.overall ? b : a))
  const flagged = buildQcFlagMessage(attempts.length, best.score, best.pass)
  return { best, attempts, flagged }
}

export function appendQcFixToPrompt(basePrompt: string, fixHint: string, attempt: number): string {
  return `${basePrompt}\n\nQC FIX (regeneration attempt ${attempt}): ${fixHint}`
}

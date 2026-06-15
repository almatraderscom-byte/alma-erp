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

const VISION_MODEL = 'gemini-2.5-flash'

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
  } catch { /* default */ }
  return 'normal'
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

function buildQcPrompt(rubricContext: string): string {
  return `Score this fashion product creative 1-5 on each axis. JSON only:
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
Use N/A=5 for text_legibility if no overlay text.
${rubricContext}`
}

function normalizeScore(raw: Partial<QCScore>): QCScore {
  const clamp = (n: unknown, fallback = 3) => {
    const v = Number(n)
    if (!Number.isFinite(v)) return fallback
    return Math.min(5, Math.max(1, Math.round(v)))
  }
  const fail_reasons = Array.isArray(raw.fail_reasons)
    ? raw.fail_reasons.map(String).slice(0, 6)
    : []
  return {
    garment_fidelity: clamp(raw.garment_fidelity),
    model_preserved: clamp(raw.model_preserved),
    anatomy: clamp(raw.anatomy),
    brand_consistency: clamp(raw.brand_consistency),
    text_legibility: clamp(raw.text_legibility, 5),
    composition: clamp(raw.composition),
    overall: clamp(raw.overall),
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
}): Promise<QCScore> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY not configured')

  const rubricContext = await buildRubricContext(args.productType)
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [
    { text: buildQcPrompt(rubricContext) },
    { inline_data: { mime_type: args.mimeType, data: args.imageBase64 } },
  ]
  if (args.productImageBase64) {
    parts.push({
      text: 'Reference product garment (compare fidelity to this):',
    })
    parts.push({
      inline_data: {
        mime_type: args.productMimeType ?? 'image/jpeg',
        data: args.productImageBase64,
      },
    })
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.15, maxOutputTokens: 768 },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`QC vision HTTP ${res.status}: ${err.slice(0, 200)}`)
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const jsonMatch = rawText.match(/\{[\s\S]*\}/)
  const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as Partial<QCScore>
  const score = normalizeScore(parsed)

  void logCost({
    provider: 'gemini',
    kind: 'qc_vision',
    units: {
      model: VISION_MODEL,
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
    } catch { /* optional */ }
  }

  return scoreCreativeQC({
    imageBase64: buf.toString('base64'),
    mimeType: mime,
    productType: args.productType,
    productImageBase64,
    productMimeType,
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
      ? normalizeScore({ overall: 5, garment_fidelity: 5, model_preserved: 5, anatomy: 5, brand_consistency: 5, text_legibility: 5, composition: 5, fail_reasons: [], fix_hint: '' })
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

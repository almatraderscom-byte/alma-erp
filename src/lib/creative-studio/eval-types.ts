/**
 * CS10 — QC 2.0 types: mode-specific thresholds + golden evaluation records.
 * Pure data + math (no I/O) so every rule here is unit-testable.
 */
import type { QCScore } from '@/lib/tryon/qc-gate'

/** Which studio surface an artifact belongs to — thresholds differ. */
export type StudioSurface = 'single_tryon' | 'family' | 'precision_edit' | 'poster' | 'video_cover'

export type SurfaceThresholds = {
  /** minimum overall to pass */
  passOverall: number
  /** hard floor for garment_fidelity / model_preserved / anatomy */
  minCoreAxis: number
  /** floor for the remaining axes (brand/text/composition) */
  minOtherAxis: number
  labelBn: string
}

/**
 * Mode-specific thresholds (roadmap CS10). Production mode uses these as-is;
 * preview only reports. Family is judged on the same core floors PLUS the
 * member-count/identity gates enforced in the worker composite path.
 */
export const SURFACE_THRESHOLDS: Record<StudioSurface, SurfaceThresholds> = {
  single_tryon: { passOverall: 4, minCoreAxis: 4, minOtherAxis: 3, labelBn: 'সিঙ্গেল ট্রাই-অন' },
  family: { passOverall: 4, minCoreAxis: 4, minOtherAxis: 3, labelBn: 'ফ্যামিলি' },
  // precision edits keep approved pixels by construction — identity/garment
  // must stay perfect; the edited region is judged via composition.
  precision_edit: { passOverall: 4, minCoreAxis: 5, minOtherAxis: 3, labelBn: 'প্রিসিশন এডিট' },
  poster: { passOverall: 4, minCoreAxis: 3, minOtherAxis: 4, labelBn: 'পোস্টার' },
  video_cover: { passOverall: 4, minCoreAxis: 4, minOtherAxis: 3, labelBn: 'ভিডিও কভার' },
}

export function surfaceForStudioMode(studioMode: string | null | undefined, familyPreset?: string | null): StudioSurface {
  if (familyPreset && familyPreset !== 'single') return 'family'
  if (studioMode === 'edit') return 'precision_edit'
  return 'single_tryon'
}

export function evaluateSurfaceScore(score: QCScore, surface: StudioSurface): boolean {
  const t = SURFACE_THRESHOLDS[surface]
  if (score.overall < t.passOverall) return false
  const core = [score.garment_fidelity, score.model_preserved, score.anatomy]
  if (core.some((n) => n < t.minCoreAxis)) return false
  const other = [score.brand_consistency, score.text_legibility, score.composition]
  return other.every((n) => n >= t.minOtherAxis)
}

// ── golden evaluation records ────────────────────────────────────────────────

export type GoldenEngineId = 'fashn' | 'fal_fashn_v16' | 'fal_idm_vton'
export const GOLDEN_ENGINES: readonly GoldenEngineId[] = ['fashn', 'fal_fashn_v16', 'fal_idm_vton']

export type GoldenCase = {
  id: string
  /** agent-files object path of the product photo */
  productImagePath: string
  /** saved model role used as the person (single-person eval) */
  modelRole: 'father' | 'mother' | 'single'
  garmentType: string
  /** fixed seed where the engine supports one (fal engines) */
  seed?: number
  notesBn?: string
}

export type EvalAttempt = {
  caseId: string
  engine: GoldenEngineId
  storagePath?: string
  requestId?: string | null
  seed?: number | null
  latencyMs: number
  costUsd: number
  score?: QCScore
  pass: boolean
  error?: string
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export type EngineReport = {
  engine: GoldenEngineId
  cases: number
  errors: number
  passRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  totalCostUsd: number
  avgCore: { garment_fidelity: number; model_preserved: number; anatomy: number; overall: number }
  /** how often each axis was the weakest on a failing attempt */
  failureAxes: Record<string, number>
}

const CORE_KEYS = ['garment_fidelity', 'model_preserved', 'anatomy', 'overall'] as const

export function summarizeEngine(engine: GoldenEngineId, attempts: EvalAttempt[]): EngineReport {
  const mine = attempts.filter((a) => a.engine === engine)
  const ok = mine.filter((a) => !a.error && a.score)
  const latencies = ok.map((a) => a.latencyMs).filter((n) => Number.isFinite(n) && n > 0)
  const avg = (k: (typeof CORE_KEYS)[number]) =>
    ok.length ? Math.round((ok.reduce((s, a) => s + Number(a.score?.[k] ?? 0), 0) / ok.length) * 100) / 100 : 0

  const failureAxes: Record<string, number> = {}
  for (const a of ok.filter((x) => !x.pass)) {
    const s = a.score!
    const axes: Array<[string, number]> = [
      ['garment_fidelity', s.garment_fidelity],
      ['model_preserved', s.model_preserved],
      ['anatomy', s.anatomy],
      ['brand_consistency', s.brand_consistency],
      ['composition', s.composition],
    ]
    axes.sort((x, y) => x[1] - y[1])
    const weakest = axes[0]?.[0]
    if (weakest) failureAxes[weakest] = (failureAxes[weakest] ?? 0) + 1
  }

  return {
    engine,
    cases: mine.length,
    errors: mine.filter((a) => a.error).length,
    passRate: ok.length ? Math.round((ok.filter((a) => a.pass).length / ok.length) * 1000) / 10 : 0,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    totalCostUsd: Math.round(mine.reduce((s, a) => s + (a.costUsd || 0), 0) * 1000) / 1000,
    avgCore: {
      garment_fidelity: avg('garment_fidelity'),
      model_preserved: avg('model_preserved'),
      anatomy: avg('anatomy'),
      overall: avg('overall'),
    },
    failureAxes,
  }
}

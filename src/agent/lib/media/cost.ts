/**
 * Media mode — server-side plan cost estimator.
 *
 * The ONLY source of the numbers on the media plan card. Recomputed on every
 * plan creation and every revision; LLM-supplied estimates are discarded.
 * Rates come from src/agent/lib/pricing.ts — update there, never here.
 */
import { roundMoney } from '@/lib/money'
import {
  calcElevenLabsMusicCostUsd,
  calcElevenLabsTtsCostUsd,
  calcGeminiImageCostUsd,
  calcSeedance25CostUsd,
  calcSeedanceCostUsd,
  calcTtsCostUsd,
  calcVeoCostUsd,
  roundUsd,
} from '@/agent/lib/pricing'
import type { MediaPlan, MediaPlanEstimate, MediaPlanEstimateLine } from './plan-schema'

export const MEDIA_USD_TO_BDT = 125

/** Seedream 5.0 Pro via fal at the DEFAULT 2K render path — must mirror the
 * worker's charge table (worker/src/index.mjs: 1K $0.0675 / 2K $0.135). */
const SEEDREAM_PER_IMAGE_USD = 0.135

function imageUnitUsd(model: MediaPlan['models']['image']): number {
  if (model === 'gemini-3-pro-image') return calcGeminiImageCostUsd('pro', '2K')
  if (model === 'gemini-3.1-flash-image') return calcGeminiImageCostUsd('standard', '2K')
  return SEEDREAM_PER_IMAGE_USD
}

function clipUsd(model: MediaPlan['models']['video'], durationSec: number): number {
  if (model === 'seedance-2.5-pro') return calcSeedance25CostUsd(durationSec, 'pro')
  if (model === 'seedance-2.5-lite') return calcSeedance25CostUsd(durationSec, 'lite')
  if (model === 'seedance-1.0-pro') return calcSeedanceCostUsd(durationSec, 'pro')
  if (model === 'seedance-1.0-lite') return calcSeedanceCostUsd(durationSec, 'lite')
  // Veo fast আর standard এখন একই veo_video রেট শেয়ার করে (fast আলাদা রেট এলে pricing.ts এ যাবে)
  return calcVeoCostUsd(durationSec)
}

const MODEL_LABELS_BN: Record<string, string> = {
  'gemini-3-pro-image': 'Nano Banana Pro',
  'gemini-3.1-flash-image': 'Nano Banana 2',
  'seedream-5.0-pro': 'Seedream 5.0 Pro',
  'seedance-2.5-pro': 'Seedance 2.5 (720p)',
  'seedance-2.5-lite': 'Seedance 2.5 (480p)',
  'seedance-1.0-pro': 'Seedance Pro',
  'seedance-1.0-lite': 'Seedance Lite',
  'veo-3.1-fast': 'Veo 3.1 Fast',
  'veo-3.1': 'Veo 3.1',
}

export function mediaModelLabel(id: string): string {
  return MODEL_LABELS_BN[id] ?? id
}

/**
 * Compute the exact estimate for a normalized plan. Every line is derived from
 * the plan itself so a revision (scene added, model swapped, VO dropped)
 * automatically re-quotes.
 */
export function estimateMediaPlanCost(plan: MediaPlan): MediaPlanEstimate {
  const lines: MediaPlanEstimateLine[] = []
  const sceneCount = plan.scenes.length
  const totalClipSec = plan.scenes.reduce((acc, s) => acc + s.durationSec, 0)

  const imgUnit = imageUnitUsd(plan.models.image)
  lines.push({
    label: `ছবি ${sceneCount} × ${mediaModelLabel(plan.models.image)}`,
    usd: roundUsd(sceneCount * imgUnit),
  })

  const clipTotal = plan.scenes.reduce((acc, s) => acc + clipUsd(plan.models.video, s.durationSec), 0)
  lines.push({
    label: `ভিডিও ক্লিপ ${sceneCount} × ${mediaModelLabel(plan.models.video)} (মোট ${Math.round(totalClipSec)}s)`,
    usd: roundUsd(clipTotal),
  })

  if (plan.audio.mode === 'vo' || plan.audio.mode === 'vo+music') {
    const chars = plan.scenes.reduce((acc, s) => acc + (s.voScript?.length ?? 0), 0)
    const voUsd =
      plan.audio.voice === 'google' ? calcTtsCostUsd(chars) : calcElevenLabsTtsCostUsd(chars)
    lines.push({
      label: `ভয়েসওভার ${chars} অক্ষর (${plan.audio.voice === 'google' ? 'Google TTS' : 'ElevenLabs'})`,
      usd: voUsd,
    })
  }
  if (plan.audio.mode === 'music' || plan.audio.mode === 'vo+music') {
    lines.push({
      label: `মিউজিক ${Math.round(totalClipSec)}s (ElevenLabs Music)`,
      usd: calcElevenLabsMusicCostUsd(totalClipSec),
    })
  }

  // স্টিচ + ক্যাপশন VPS worker-এ চলে — প্রোভাইডার খরচ শূন্য, তাই লাইন দেখাই ০ ডলারে।
  lines.push({ label: 'স্টিচ + ক্যাপশন (VPS)', usd: 0 })

  const totalUsd = roundUsd(lines.reduce((acc, l) => acc + l.usd, 0))
  return { lines, totalUsd, totalBdt: roundMoney(totalUsd * MEDIA_USD_TO_BDT) }
}

/** Bangla-facing one-line-per-item cost block for the approval card summary. */
export function formatEstimateBn(est: MediaPlanEstimate): string {
  const rows = est.lines.map((l) => `- ${l.label}: $${l.usd.toFixed(2)}`)
  rows.push(`**মোট ≈ $${est.totalUsd.toFixed(2)} (৳${est.totalBdt})**`)
  return rows.join('\n')
}

import { roundMoney } from '@/lib/money'

export type StudioAssetState = 'ready' | 'qc_failed' | 'draft' | 'processing' | 'failed'
export type StudioPublishAction = 'finish' | 'reel' | 'video_finish' | 'publish'

type StudioAssetLike = {
  status?: string | null
  result?: Record<string, unknown> | null
  hasArtifact?: boolean
}

const PENDING = new Set(['approved', 'pending', 'processing'])
const FAILED = new Set(['failed', 'error', 'rejected'])

function passValue(value: unknown): boolean | null {
  if (!value || typeof value !== 'object') return null
  const pass = (value as { pass?: unknown }).pass
  return typeof pass === 'boolean' ? pass : null
}

export function hasExplicitQcFailure(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false
  return passValue(result.qc) === false || passValue(result.videoQc) === false
}

export function hasExplicitQcPass(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false
  return passValue(result.qc) === true || passValue(result.videoQc) === true
}

export function classifyStudioAsset(asset: StudioAssetLike): StudioAssetState {
  const status = asset.status ?? ''
  if (PENDING.has(status)) return 'processing'
  if (FAILED.has(status)) return 'failed'
  if (hasExplicitQcFailure(asset.result)) return 'qc_failed'
  if (status === 'executed' && asset.hasArtifact !== false) return 'ready'
  return 'draft'
}

export function studioActionBlockReason(
  asset: StudioAssetLike | null | undefined,
  _action: StudioPublishAction,
): string | null {
  if (!asset) return 'Creative-টি খুঁজে পাওয়া যায়নি।'
  if (hasExplicitQcFailure(asset.result)) {
    return 'এই Creative-টির QC ফেল করেছে। আগে Repair বা Retry করে QC পাস করান।'
  }
  if (asset.status !== 'executed') return 'Creative-টি তৈরি শেষ না হওয়া পর্যন্ত এই কাজ করা যাবে না।'
  if (asset.hasArtifact === false) return 'Creative file প্রস্তুত নেই। আবার চালিয়ে দেখুন।'
  return null
}

export function isStudioAssetPublishable(asset: StudioAssetLike): boolean {
  return studioActionBlockReason(asset, 'publish') === null
}

export const DEFAULT_STUDIO_RUN_CAP_BDT = 500
export const MAX_STUDIO_RUN_CAP_BDT = 5_000

export function normalizeStudioRunCap(value: unknown): number {
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) return DEFAULT_STUDIO_RUN_CAP_BDT
  return Math.min(MAX_STUDIO_RUN_CAP_BDT, Math.max(1, roundMoney(parsed)))
}

export type StudioCostGate =
  | { ok: false; reason: 'confirmation_required'; estimateBdt: number; capBdt: number }
  | { ok: false; reason: 'cap_exceeded'; estimateBdt: number; capBdt: number }
  | { ok: false; reason: 'estimate_changed'; estimateBdt: number; capBdt: number }
  | { ok: true; estimateBdt: number; capBdt: number }

export function checkStudioCostConfirmation(input: {
  estimateBdt: number
  confirmedCostBdt?: unknown
  capBdt?: unknown
}): StudioCostGate {
  const estimateBdt = Math.max(0, roundMoney(input.estimateBdt))
  const capBdt = normalizeStudioRunCap(input.capBdt)
  if (estimateBdt > capBdt) return { ok: false, reason: 'cap_exceeded', estimateBdt, capBdt }

  const confirmed = typeof input.confirmedCostBdt === 'number' || typeof input.confirmedCostBdt === 'string'
    ? roundMoney(Number(input.confirmedCostBdt))
    : null
  if (confirmed === null || !Number.isFinite(confirmed)) {
    return { ok: false, reason: 'confirmation_required', estimateBdt, capBdt }
  }
  if (confirmed !== estimateBdt) return { ok: false, reason: 'estimate_changed', estimateBdt, capBdt }
  return { ok: true, estimateBdt, capBdt }
}

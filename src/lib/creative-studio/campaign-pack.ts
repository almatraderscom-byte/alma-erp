export const CAMPAIGN_PACK_VERSION = 1 as const
export const CAMPAIGN_PACK_HARD_CAP_USD = 1
export const CAMPAIGN_PACK_USD_TO_BDT = 125

export type CampaignPackStageId =
  | 'draft-a'
  | 'draft-b'
  | 'hero-4x5'
  | 'post-1x1'
  | 'story-9x16'
  | 'caption-bn'
  | 'family-4x5'
  | 'reel-6s'

export type CampaignPackOptions = {
  includeFamily: boolean
  includeReel: boolean
}

export type CampaignPackProduct = {
  code: string
  name: string
  priceBdt: number
  sourceImage: string
}

export type CampaignPackRecipe = {
  id: string
  name: string
  version: number
  lockedAt: string
  captionTone: string
  finishTheme: string
  musicVibe: string
  qcLevel: string
  spendCeilingBdt: number
}

export type CampaignPackStageDefinition = {
  id: CampaignPackStageId
  labelBn: string
  outputLabelBn: string
  phase: 'draft' | 'after_selection'
  mediaType: 'image' | 'text' | 'video'
  engine: string
  width: number | null
  height: number | null
  estimatedSeconds: number
  estimatedCostUsd: number
  paid: boolean
  optional: boolean
}

export type CampaignPackManifest = {
  version: typeof CAMPAIGN_PACK_VERSION
  projectId: string
  product: CampaignPackProduct
  recipe: CampaignPackRecipe
  masterSource: {
    kind: 'approved_project_asset' | 'erp_product'
    storagePath: string
    assetId: string | null
    pendingActionId: string | null
  }
  options: CampaignPackOptions
  outputs: Array<{
    stageId: CampaignPackStageId
    labelBn: string
    mediaType: 'image' | 'text' | 'video'
    optional: boolean
  }>
  stages: CampaignPackStageDefinition[]
  estimatedSeconds: number
  estimatedCostUsd: number
  estimatedCostBdt: number
  hardCostCeilingUsd: number
  requiresPaidConfirmation: boolean
}

export type CampaignPackStageSnapshot = {
  stageId: CampaignPackStageId
  attempt: number
  status: string
}

export class CampaignPackContractError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'CampaignPackContractError'
    this.code = code
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function integer(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

export function normalizeCampaignPackOptions(value: unknown): CampaignPackOptions {
  const input = record(value)
  return {
    includeFamily: input.includeFamily === true,
    includeReel: input.includeReel === true,
  }
}

export function normalizeCampaignPackProduct(value: unknown): CampaignPackProduct {
  const input = record(value)
  const code = text(input.code, 64)
  const name = text(input.name, 160)
  const sourceImage = text(input.sourceImage, 2_000)
  if (!code || !name || !sourceImage) throw new CampaignPackContractError('product_required')
  return { code, name, sourceImage, priceBdt: integer(input.priceBdt) }
}

export function normalizeCampaignPackRecipe(value: unknown): CampaignPackRecipe {
  const input = record(value)
  const id = text(input.id, 80)
  const name = text(input.name, 160)
  const lockedAt = text(input.lockedAt, 80)
  if (!id || !name) throw new CampaignPackContractError('recipe_required')
  if (!lockedAt) throw new CampaignPackContractError('recipe_must_be_locked')
  return {
    id,
    name,
    version: Math.max(1, integer(input.version)),
    lockedAt,
    captionTone: text(input.captionTone, 80) || 'premium',
    finishTheme: text(input.finishTheme, 80) || 'default',
    musicVibe: text(input.musicVibe, 80) || 'premium',
    qcLevel: text(input.qcLevel, 80) || 'strict',
    spendCeilingBdt: integer(input.spendCeilingBdt),
  }
}

function requiredStages(): CampaignPackStageDefinition[] {
  return [
    ['draft-a', 'প্রিভিউ ড্রাফট A', 'ড্রাফট A', 'draft', 'image', 'Sharp · local/free', 1080, 1350, 12],
    ['draft-b', 'প্রিভিউ ড্রাফট B', 'ড্রাফট B', 'draft', 'image', 'Sharp · local/free', 1080, 1350, 12],
    ['hero-4x5', '4:5 হিরো', '4:5 Hero', 'after_selection', 'image', 'Sharp · local/free', 1080, 1350, 10],
    ['post-1x1', '1:1 পোস্ট', '1:1 Post', 'after_selection', 'image', 'Sharp · local/free', 1080, 1080, 10],
    ['story-9x16', '9:16 স্টোরি / রিল কভার', '9:16 Story / Reel cover', 'after_selection', 'image', 'Sharp · local/free', 1080, 1920, 10],
    ['caption-bn', 'বাংলা ক্যাপশন ড্রাফট', 'Bangla caption', 'after_selection', 'text', 'Deterministic template · local/free', null, null, 2],
  ].map((row) => ({
    id: row[0] as CampaignPackStageId,
    labelBn: row[1] as string,
    outputLabelBn: row[2] as string,
    phase: row[3] as CampaignPackStageDefinition['phase'],
    mediaType: row[4] as CampaignPackStageDefinition['mediaType'],
    engine: row[5] as string,
    width: row[6] as number | null,
    height: row[7] as number | null,
    estimatedSeconds: row[8] as number,
    estimatedCostUsd: 0,
    paid: false,
    optional: false,
  }))
}

export function buildCampaignPackManifest(input: {
  projectId: string
  product: CampaignPackProduct
  recipe: CampaignPackRecipe
  masterSource?: CampaignPackManifest['masterSource']
  options?: Partial<CampaignPackOptions>
}): CampaignPackManifest {
  const projectId = text(input.projectId, 80)
  if (!projectId) throw new CampaignPackContractError('project_required')
  const product = normalizeCampaignPackProduct(input.product)
  const recipe = normalizeCampaignPackRecipe(input.recipe)
  const options = normalizeCampaignPackOptions(input.options)
  const stages = requiredStages()

  if (options.includeFamily) {
    stages.push({
      id: 'family-4x5',
      labelBn: 'ঐচ্ছিক ফ্যামিলি ভার্সন',
      outputLabelBn: 'Family version',
      phase: 'after_selection',
      mediaType: 'image',
      engine: 'Gemini 3.1 Flash Image',
      width: 1080,
      height: 1350,
      estimatedSeconds: 60,
      estimatedCostUsd: 0.04,
      paid: true,
      optional: true,
    })
  }
  if (options.includeReel) {
    stages.push({
      id: 'reel-6s',
      labelBn: 'ঐচ্ছিক 6-সেকেন্ড রিল',
      outputLabelBn: '6-second reel',
      phase: 'after_selection',
      mediaType: 'video',
      engine: 'Veo 3.1',
      width: 1080,
      height: 1920,
      estimatedSeconds: 240,
      estimatedCostUsd: 0.9,
      paid: true,
      optional: true,
    })
  }

  const estimatedCostUsd = Math.round(
    stages.reduce((sum, stage) => sum + stage.estimatedCostUsd, 0) * 1000,
  ) / 1000
  return {
    version: CAMPAIGN_PACK_VERSION,
    projectId,
    product,
    recipe,
    masterSource: input.masterSource ?? {
      kind: 'erp_product',
      storagePath: product.sourceImage,
      assetId: null,
      pendingActionId: null,
    },
    options,
    outputs: stages.map((stage) => ({
      stageId: stage.id,
      labelBn: stage.outputLabelBn,
      mediaType: stage.mediaType,
      optional: stage.optional,
    })),
    stages,
    estimatedSeconds: stages.reduce((sum, stage) => sum + stage.estimatedSeconds, 0),
    estimatedCostUsd,
    estimatedCostBdt: Math.ceil(estimatedCostUsd * CAMPAIGN_PACK_USD_TO_BDT),
    hardCostCeilingUsd: CAMPAIGN_PACK_HARD_CAP_USD,
    requiresPaidConfirmation: estimatedCostUsd > 0,
  }
}

export function assertCampaignPackCostAllowed(manifest: CampaignPackManifest): void {
  if (manifest.estimatedCostUsd > manifest.hardCostCeilingUsd) {
    throw new CampaignPackContractError('hard_cost_cap_exceeded')
  }
  if (manifest.estimatedCostBdt > manifest.recipe.spendCeilingBdt) {
    throw new CampaignPackContractError('recipe_cost_cap_exceeded')
  }
}

export function assertCampaignPackConfirmation(
  manifest: CampaignPackManifest,
  confirmedCostUsd: unknown,
): void {
  const confirmed = Number(confirmedCostUsd)
  if (!Number.isFinite(confirmed) || Math.abs(confirmed - manifest.estimatedCostUsd) > 0.0001) {
    throw new CampaignPackContractError('cost_confirmation_required')
  }
  assertCampaignPackCostAllowed(manifest)
}

export function latestCampaignStageAttempts(
  snapshots: CampaignPackStageSnapshot[],
): Map<CampaignPackStageId, CampaignPackStageSnapshot> {
  const latest = new Map<CampaignPackStageId, CampaignPackStageSnapshot>()
  for (const snapshot of snapshots) {
    const previous = latest.get(snapshot.stageId)
    if (!previous || snapshot.attempt > previous.attempt) latest.set(snapshot.stageId, snapshot)
  }
  return latest
}

export function campaignStagesMissingForResume(input: {
  manifest: CampaignPackManifest
  snapshots: CampaignPackStageSnapshot[]
  selectedDraftStageId?: CampaignPackStageId | null
}): CampaignPackStageDefinition[] {
  const latest = latestCampaignStageAttempts(input.snapshots)
  const eligible = input.selectedDraftStageId
    ? input.manifest.stages
    : input.manifest.stages.filter((stage) => stage.phase === 'draft')
  return eligible.filter((stage) => !latest.has(stage.id))
}

export function campaignPackDedupeKey(ownerId: string, idempotencyKey: string): string {
  return `campaign-pack:${ownerId}:${idempotencyKey}`
}

export function campaignStageDedupeKey(
  packId: string,
  stageId: CampaignPackStageId,
  attempt: number,
): string {
  return `campaign-pack-stage:${packId}:${stageId}:attempt:${Math.max(1, Math.round(attempt))}`
}

export function campaignStagePrefix(packId: string): string {
  return `campaign-pack-stage:${packId}:`
}

export function campaignPackRequestFingerprint(manifest: CampaignPackManifest): string {
  return [
    manifest.projectId,
    manifest.product.code,
    manifest.product.sourceImage,
    manifest.masterSource.storagePath,
    manifest.recipe.id,
    manifest.recipe.version,
    manifest.options.includeFamily ? 'family' : 'no-family',
    manifest.options.includeReel ? 'reel' : 'no-reel',
  ].join('|')
}

import { roundMoney } from '@/lib/money'

export const LEGACY_PROJECT_ID = 'legacy'
export const DEFAULT_PROJECT_FOLDER = 'Unsorted'

export type StudioProjectSummary = {
  id: string
  name: string
  description: string | null
  readonly: boolean
  assetCount: number
  brandProfileId: string | null
  currentRecipeId: string | null
  currentRecipe: {
    id: string
    name: string
    version: number
    locked: boolean
  } | null
  product: StudioProductOption | null
  defaultFolder: string
  updatedAt: string | null
}

export type StudioProductOption = {
  code: string
  name: string
  priceBdt: number
  /** Stable ERP/storage reference copied into the project snapshot. */
  sourceImage: string | null
  /** Renderable signed/remote URL; never persisted as the source reference. */
  previewImage?: string | null
  available: number | null
}

export type StudioBrandRecipe = {
  id: string
  brandProfileId: string
  brandName: string
  recipeKey: string
  version: number
  name: string
  sceneSubset: string[]
  modelRoles: string[]
  finishTheme: string
  captionTone: string
  aspectPack: string[]
  musicVibe: string
  qcLevel: 'off' | 'normal' | 'strict'
  spendCeilingBdt: number
  locked: boolean
  lockedAt: string | null
  createdAt: string
  updatedAt: string
}

export type StudioAssetVersion = {
  id: string
  version: number
  storagePath: string | null
  previewUrl: string | null
  recipeId: string | null
  recipeName: string | null
  recipeVersion: number | null
  provider: string | null
  engine: string | null
  jobId: string | null
  costBdt: number
  costUsd: number | null
  qc: Record<string, unknown> | null
  createdById: string
  createdAt: string
  sources: Array<{
    id: string
    title: string | null
    pendingActionId: string | null
    relationKind: string
  }>
}

export type StudioProjectAsset = {
  id: string
  projectId: string
  pendingActionId: string | null
  assetType: string
  title: string | null
  folder: string
  previewUrl: string | null
  storagePath: string | null
  status: string
  tags: Array<{ id: string; name: string; slug: string; color: string }>
  versions: StudioAssetVersion[]
  createdById: string
  createdAt: string
  updatedAt: string
  readonly?: boolean
}

export type ProjectCreateInput = {
  name: string
  description: string | null
  brandName: string
  defaultFolder: string
}

export type ProjectPatchInput = {
  name?: string
  description?: string | null
  brandProfileId?: string | null
  currentRecipeId?: string | null
  productCode?: string | null
  productName?: string | null
  productPriceBdt?: number | null
  productSourceImage?: string | null
  defaultFolder?: string
  archive?: boolean
}

export type ProjectAssetLinkInput = {
  pendingActionId: string
  title: string | null
  folder: string
  tags: string[]
  recipeId: string | null
  sourceAssetIds: string[]
  sourcePendingActionIds: string[]
}

export type ProjectAssetPatchInput = {
  assetId: string
  title?: string | null
  folder?: string
  tags?: string[]
}

export class ProjectContractError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'ProjectContractError'
    this.code = code
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectContractError('invalid_input')
  }
  return value as Record<string, unknown>
}

function cleanText(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/\s+/g, ' ').slice(0, max)
}

function nullableText(value: unknown, max: number): string | null {
  const clean = cleanText(value, max)
  return clean || null
}

function optionalNullableText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | null | undefined {
  if (!(key in body)) return undefined
  if (body[key] === null) return null
  return nullableText(body[key], max)
}

export function normalizeFolder(value: unknown): string {
  return cleanText(value, 64, DEFAULT_PROJECT_FOLDER) || DEFAULT_PROJECT_FOLDER
}

export function slugifyAssetTag(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('bn-BD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function normalizeTagNames(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const unique = new Map<string, string>()
  for (const entry of raw) {
    const name = cleanText(entry, 40)
    const slug = slugifyAssetTag(name)
    if (name && slug && !unique.has(slug)) unique.set(slug, name)
    if (unique.size >= 12) break
  }
  return [...unique.values()]
}

export function normalizeIdList(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, max)
}

export function normalizeProjectCreateInput(value: unknown): ProjectCreateInput {
  const body = asRecord(value)
  const name = cleanText(body.name, 80)
  if (name.length < 2) throw new ProjectContractError('project_name_required')
  return {
    name,
    description: nullableText(body.description, 500),
    brandName: cleanText(body.brandName, 80, 'ALMA Lifestyle') || 'ALMA Lifestyle',
    defaultFolder: normalizeFolder(body.defaultFolder),
  }
}

export function normalizeProjectPatchInput(value: unknown): ProjectPatchInput {
  const body = asRecord(value)
  const patch: ProjectPatchInput = {}

  if ('name' in body) {
    const name = cleanText(body.name, 80)
    if (name.length < 2) throw new ProjectContractError('project_name_required')
    patch.name = name
  }
  patch.description = optionalNullableText(body, 'description', 500)
  patch.brandProfileId = optionalNullableText(body, 'brandProfileId', 80)
  patch.currentRecipeId = optionalNullableText(body, 'currentRecipeId', 80)
  patch.productCode = optionalNullableText(body, 'productCode', 64)
  patch.productName = optionalNullableText(body, 'productName', 160)
  patch.productSourceImage = optionalNullableText(body, 'productSourceImage', 2_000)

  if ('productPriceBdt' in body) {
    if (body.productPriceBdt === null) patch.productPriceBdt = null
    else {
      const number = Number(body.productPriceBdt)
      if (!Number.isFinite(number) || number < 0) throw new ProjectContractError('invalid_product_price')
      patch.productPriceBdt = roundMoney(number)
    }
  }
  if ('defaultFolder' in body) patch.defaultFolder = normalizeFolder(body.defaultFolder)
  if ('archive' in body) patch.archive = body.archive === true
  return patch
}

export function normalizeProjectAssetLinkInput(value: unknown): ProjectAssetLinkInput {
  const body = asRecord(value)
  const pendingActionId = cleanText(body.pendingActionId, 80)
  if (!pendingActionId) throw new ProjectContractError('pending_action_required')
  return {
    pendingActionId,
    title: nullableText(body.title, 160),
    folder: normalizeFolder(body.folder),
    tags: normalizeTagNames(body.tags),
    recipeId: nullableText(body.recipeId, 80),
    sourceAssetIds: normalizeIdList(body.sourceAssetIds),
    sourcePendingActionIds: normalizeIdList(body.sourcePendingActionIds),
  }
}

export function normalizeProjectAssetPatchInput(value: unknown): ProjectAssetPatchInput {
  const body = asRecord(value)
  const assetId = cleanText(body.assetId, 80)
  if (!assetId) throw new ProjectContractError('asset_id_required')
  const patch: ProjectAssetPatchInput = { assetId }
  if ('title' in body) patch.title = nullableText(body.title, 160)
  if ('folder' in body) patch.folder = normalizeFolder(body.folder)
  if ('tags' in body) patch.tags = normalizeTagNames(body.tags)
  return patch
}

export function ownedProjectWhere(ownerId: string, projectId: string) {
  return {
    id: projectId,
    ownerId,
    archivedAt: null,
  }
}

export function ownedRecipeWhere(ownerId: string, recipeId: string) {
  return {
    id: recipeId,
    ownerId,
  }
}

export function isLegacyProjectId(value: string): boolean {
  return value === LEGACY_PROJECT_ID
}

export function assetTypeFromJob(type: unknown): string {
  const value = typeof type === 'string' ? type : ''
  if (value.startsWith('video')) return 'video'
  if (value.startsWith('audio')) return 'audio'
  return 'image'
}

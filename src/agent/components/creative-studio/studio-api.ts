import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import type { EngineAvailability, StudioEngineId } from '@/lib/creative-studio/provider-registry'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import type { LifestyleLayoutOverrides } from '@/lib/content-engine/lifestyle-layout'
import type { GalleryMediaFilter, GalleryQcFilter, GalleryStateFilter } from '@/lib/creative-studio/gallery-query'
import type { StudioAssetState } from '@/lib/creative-studio/studio-policy'
import type { StudioArtifactDescriptor } from '@/lib/creative-studio/artifact-metadata'
import type {
  StudioBrandRecipe,
  StudioProductOption,
  StudioProjectAsset,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import type {
  CampaignPackManifest,
  CampaignPackStageId,
} from '@/lib/creative-studio/campaign-pack'
import type { VideoEditContract } from '@/lib/creative-studio/video-edit-contract'
import { sanitizeStudioError } from '@/lib/creative-studio/studio-errors'

export const STUDIO_NAV_DEFINITIONS = [
  { id: 'studio', label: 'স্টুডিও' },
  { id: 'gallery', label: 'গ্যালারি' },
  { id: 'video', label: 'ভিডিও' },
  { id: 'audio', label: 'অডিও' },
  { id: 'library', label: 'লাইব্রেরি' },
] as const

export type StudioView = (typeof STUDIO_NAV_DEFINITIONS)[number]['id']

export function isStudioView(value: unknown): value is StudioView {
  return typeof value === 'string' && STUDIO_NAV_DEFINITIONS.some((item) => item.id === value)
}

export function normalizeStudioView(value: unknown): StudioView {
  return isStudioView(value) ? value : 'studio'
}

export class StudioClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'StudioClientError'
    this.status = status
    this.code = code
  }
}

function errorCodeFromPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const value = (payload as Record<string, unknown>).code ?? (payload as Record<string, unknown>).error
  return typeof value === 'string' && /^[a-z0-9_-]{2,80}$/i.test(value) ? value.toLowerCase() : fallback
}

export function normalizeStudioApiError(payload: unknown, status: number, fallback: string): StudioClientError {
  return new StudioClientError(sanitizeStudioError(payload, status), status, errorCodeFromPayload(payload, fallback))
}

export async function readStudioResponse<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw normalizeStudioApiError(data, res.status, fallback)
  return data as T
}

export async function studioRequest<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<T> {
  try {
    const response = await fetch(input, init)
    return await readStudioResponse<T>(response, fallback)
  } catch (error) {
    if (error instanceof StudioClientError) throw error
    throw normalizeStudioApiError(error, 0, fallback)
  }
}

// ── CSE3: active Content OS context ─────────────────────────────────────────

export type StudioContentContext = {
  brandProfileId: string
  projectId: string
  productId: string | null
  recipeId: string | null
  folder: string
  tags?: string[]
}

let activeContentContext: StudioContentContext | null = null

export function setActiveStudioContentContext(context: StudioContentContext | null) {
  activeContentContext = context
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('alma-studio-content-context', { detail: context }))
  }
}

export function getActiveStudioContentContext(): StudioContentContext | null {
  return activeContentContext
}

export type CampaignPackStageClient = {
  stageId: CampaignPackStageId
  actionId: string | null
  attempt: number
  labelBn: string
  mediaType: 'image' | 'text' | 'video'
  engine: string
  estimatedCostUsd: number
  status: 'not_started' | 'queued' | 'running' | 'ready' | 'failed' | 'rejected'
  storagePath: string | null
  previewUrl: string | null
  captionBn: string | null
  error: string | null
}

export type CampaignPackClient = {
  id: string
  status: 'drafting' | 'waiting_selection' | 'processing' | 'ready' | 'attention'
  manifest: CampaignPackManifest
  selectedDraftStageId: CampaignPackStageId | null
  progressPercent: number
  estimatedCostUsd: number
  actualCostUsd: number
  createdAt: string
  updatedAt: string
  stages: CampaignPackStageClient[]
}

export async function previewCampaignPack(input: {
  projectId: string
  includeFamily: boolean
  includeReel: boolean
}): Promise<CampaignPackManifest> {
  const data = await studioRequest<{ manifest: CampaignPackManifest }>(
    '/api/assistant/creative-studio/campaign-packs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'preview',
        projectId: input.projectId,
        options: {
          includeFamily: input.includeFamily,
          includeReel: input.includeReel,
        },
      }),
    },
    'campaign_pack_preview_failed',
  )
  return data.manifest
}

export async function queueCampaignPack(input: {
  projectId: string
  includeFamily: boolean
  includeReel: boolean
  idempotencyKey: string
  confirmedCostUsd: number
}): Promise<{ pack: CampaignPackClient; idempotent: boolean }> {
  return studioRequest<{ pack: CampaignPackClient; idempotent: boolean }>(
    '/api/assistant/creative-studio/campaign-packs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'queue',
        projectId: input.projectId,
        options: {
          includeFamily: input.includeFamily,
          includeReel: input.includeReel,
        },
        idempotencyKey: input.idempotencyKey,
        confirmedCostUsd: input.confirmedCostUsd,
      }),
    },
    'campaign_pack_queue_failed',
  )
}

export async function fetchCampaignPack(packId: string): Promise<CampaignPackClient> {
  const data = await studioRequest<{ pack: CampaignPackClient }>(
    `/api/assistant/creative-studio/campaign-packs/${encodeURIComponent(packId)}`,
    undefined,
    'campaign_pack_fetch_failed',
  )
  return data.pack
}

export async function listCampaignPacks(projectId: string): Promise<CampaignPackClient[]> {
  const query = new URLSearchParams({ projectId })
  const data = await studioRequest<{ packs: CampaignPackClient[] }>(
    `/api/assistant/creative-studio/campaign-packs?${query.toString()}`,
    undefined,
    'campaign_pack_list_failed',
  )
  return data.packs
}

export async function selectCampaignPackDraft(
  packId: string,
  selectedDraftStageId: 'draft-a' | 'draft-b',
): Promise<CampaignPackClient> {
  const data = await studioRequest<{ pack: CampaignPackClient }>(
    `/api/assistant/creative-studio/campaign-packs/${encodeURIComponent(packId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'select_draft', selectedDraftStageId }),
    },
    'campaign_pack_selection_failed',
  )
  return data.pack
}

export async function retryCampaignPackStage(input: {
  packId: string
  stageId: CampaignPackStageId
  confirmedCostUsd?: number
  reason?: string
}): Promise<CampaignPackClient> {
  const data = await studioRequest<{ pack: CampaignPackClient }>(
    `/api/assistant/creative-studio/campaign-packs/${encodeURIComponent(input.packId)}/retry`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stageId: input.stageId,
        confirmedCostUsd: input.confirmedCostUsd,
        reason: input.reason,
      }),
    },
    'campaign_pack_retry_failed',
  )
  return data.pack
}

async function linkQueuedStudioJobs(
  jobs: Array<{ pendingActionId: string }>,
  sourcePendingActionIds: string[] = [],
): Promise<void> {
  const context = activeContentContext
  if (!context || context.projectId === 'legacy' || jobs.length === 0) return
  const uniqueSources = [...new Set(sourcePendingActionIds.filter(Boolean))]
  const results = await Promise.allSettled(
    jobs.map((job) => studioRequest<unknown>(
      `/api/assistant/creative-studio/projects/${encodeURIComponent(context.projectId)}/assets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pendingActionId: job.pendingActionId,
          recipeId: context.recipeId,
          folder: context.folder,
          tags: context.tags ?? [],
          sourcePendingActionIds: uniqueSources,
        }),
      },
      'project_asset_link_failed',
    )),
  )
  // Generation has already been queued at this point; never report it as failed
  // because a secondary catalog write was unavailable. The job remains visible
  // in Legacy and can be attached from the project library without data loss.
  if (results.some((result) => result.status === 'rejected')) {
    console.warn('[creative-content-os] one or more queued jobs stayed in Legacy')
  }
}

export async function fetchStudioProjects(
  brandProfileId?: string | null,
): Promise<StudioProjectSummary[]> {
  const query = new URLSearchParams()
  if (brandProfileId) query.set('brandProfileId', brandProfileId)
  const data = await studioRequest<{ projects: StudioProjectSummary[] }>(
    `/api/assistant/creative-studio/projects${query.size ? `?${query.toString()}` : ''}`,
    undefined,
    'projects_failed',
  )
  return data.projects
}

export async function createStudioProject(input: {
  name: string
  description?: string
  brandName?: string
  defaultFolder?: string
}): Promise<StudioProjectSummary> {
  const data = await studioRequest<{ project: StudioProjectSummary }>(
    '/api/assistant/creative-studio/projects',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'project_create_failed',
  )
  return data.project
}

export async function updateStudioProject(
  projectId: string,
  patch: Record<string, unknown>,
): Promise<StudioProjectSummary> {
  const data = await studioRequest<{ project: StudioProjectSummary }>(
    `/api/assistant/creative-studio/projects/${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    'project_update_failed',
  )
  return data.project
}

export async function fetchErpProducts(query = ''): Promise<StudioProductOption[]> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('q', query.trim())
  const data = await studioRequest<{ products: StudioProductOption[] }>(
    `/api/assistant/creative-studio/products?${params.toString()}`,
    undefined,
    'products_failed',
  )
  return data.products
}

export async function fetchBrandRecipes(brandProfileId?: string | null): Promise<StudioBrandRecipe[]> {
  const params = new URLSearchParams()
  if (brandProfileId) params.set('brandProfileId', brandProfileId)
  const data = await studioRequest<{ recipes: StudioBrandRecipe[] }>(
    `/api/assistant/creative-studio/recipes?${params.toString()}`,
    undefined,
    'recipes_failed',
  )
  return data.recipes
}

export async function createStudioBrandRecipe(input: Record<string, unknown>): Promise<StudioBrandRecipe> {
  const data = await studioRequest<{ recipe: StudioBrandRecipe }>(
    '/api/assistant/creative-studio/recipes',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'recipe_create_failed',
  )
  return data.recipe
}

export async function updateStudioBrandRecipe(
  recipeId: string,
  patch: Record<string, unknown>,
): Promise<StudioBrandRecipe> {
  const data = await studioRequest<{ recipe: StudioBrandRecipe }>(
    `/api/assistant/creative-studio/recipes/${encodeURIComponent(recipeId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    'recipe_update_failed',
  )
  return data.recipe
}

export async function fetchProjectAssets(projectId: string): Promise<StudioProjectAsset[]> {
  const data = await studioRequest<{ assets: StudioProjectAsset[] }>(
    `/api/assistant/creative-studio/projects/${encodeURIComponent(projectId)}/assets`,
    undefined,
    'project_assets_failed',
  )
  return data.assets
}

export async function attachProjectAsset(
  projectId: string,
  input: {
    pendingActionId: string
    title?: string
    folder?: string
    tags?: string[]
    recipeId?: string | null
    sourceAssetIds?: string[]
    sourcePendingActionIds?: string[]
  },
): Promise<StudioProjectAsset> {
  const data = await studioRequest<{ asset: StudioProjectAsset }>(
    `/api/assistant/creative-studio/projects/${encodeURIComponent(projectId)}/assets`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'project_asset_link_failed',
  )
  return data.asset
}

export async function updateProjectAsset(
  projectId: string,
  input: { assetId: string; title?: string; folder?: string; tags?: string[] },
): Promise<StudioProjectAsset> {
  const data = await studioRequest<{ asset: StudioProjectAsset }>(
    `/api/assistant/creative-studio/projects/${encodeURIComponent(projectId)}/assets`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'project_asset_update_failed',
  )
  return data.asset
}

// ── CSE6: review, approval, and multi-brand ─────────────────────────────────

export type StudioAccessRole = 'owner' | 'creator' | 'reviewer'
export type StudioReviewState = 'draft' | 'changes_requested' | 'revised' | 'approved'

export type StudioBrandProfile = {
  brandProfileId: string
  ownerId: string
  name: string
  organization: string | null
  notes: string | null
  role: StudioAccessRole
  approvalSpendThresholdBdt: number
  projectCount: number
  recipeCount: number
  assetCount: number
}

export type StudioRoleAssignment = {
  id: string
  brandProfileId: string
  userId: string
  userName: string
  userEmail: string | null
  erpRole: string
  role: Exclude<StudioAccessRole, 'owner'>
  createdAt: string
}

export type StudioEligibleUser = {
  id: string
  name: string
  email: string | null
  erpRole: string
}

export type StudioRoleSettings = {
  assignments: StudioRoleAssignment[]
  eligibleUsers: StudioEligibleUser[]
}

export type StudioReviewThread = {
  assetId: string
  brandProfileId: string
  brandName: string
  projectId: string
  projectName: string
  assetTitle: string | null
  currentState: StudioReviewState
  currentSequence: number
  latestVersionId: string | null
  approvedVersionId: string | null
  approvedCompositionId: string | null
  approvedCompositionVersionId: string | null
  approvedCompositionVersion: number | null
  approvedCompositionDocumentHash: string | null
  approvalInvalidatedReason: string | null
  publishReady: boolean
  role: StudioAccessRole
  approvalSpendThresholdBdt: number
  capabilities: {
    comment: boolean
    requestChanges: boolean
    markRevised: boolean
    approve: boolean
  }
  comments: Array<{
    id: string
    authorId: string
    authorName: string
    authorRole: StudioAccessRole
    body: string
    createdAt: string
  }>
  events: Array<{
    id: string
    sequence: number
    fromState: StudioReviewState | null
    toState: StudioReviewState
    actorId: string
    actorName: string
    actorRole: StudioAccessRole
    note: string | null
    approvedVersionId: string | null
    approvedCompositionId: string | null
    approvedCompositionVersionId: string | null
    approvedCompositionVersion: number | null
    approvedCompositionDocumentHash: string | null
    createdAt: string
  }>
}

export async function fetchStudioBrands(): Promise<StudioBrandProfile[]> {
  const data = await studioRequest<{ brands: StudioBrandProfile[] }>(
    '/api/assistant/creative-studio/brands',
    undefined,
    'studio_brands_failed',
  )
  return data.brands
}

export async function updateStudioBrand(input: {
  brandProfileId: string
  approvalSpendThresholdBdt: number
  notes?: string | null
}): Promise<StudioBrandProfile[]> {
  const data = await studioRequest<{ brands: StudioBrandProfile[] }>(
    '/api/assistant/creative-studio/brands',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'studio_brand_update_failed',
  )
  return data.brands
}

export async function fetchStudioRoleSettings(
  brandProfileId: string,
): Promise<StudioRoleSettings> {
  const query = new URLSearchParams({ brandProfileId })
  return studioRequest<StudioRoleSettings>(
    `/api/assistant/creative-studio/roles?${query.toString()}`,
    undefined,
    'studio_roles_failed',
  )
}

export async function assignStudioRole(input: {
  brandProfileId: string
  userId: string
  role: Exclude<StudioAccessRole, 'owner'>
}): Promise<StudioRoleSettings> {
  return studioRequest<StudioRoleSettings>(
    '/api/assistant/creative-studio/roles',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'studio_role_assign_failed',
  )
}

export async function removeStudioRole(input: {
  brandProfileId: string
  userId: string
}): Promise<StudioRoleSettings> {
  return studioRequest<StudioRoleSettings>(
    '/api/assistant/creative-studio/roles',
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'studio_role_remove_failed',
  )
}

export async function fetchStudioReview(
  assetId: string,
  brandProfileId: string,
): Promise<StudioReviewThread> {
  const query = new URLSearchParams({ assetId, brandProfileId })
  const data = await studioRequest<{ review: StudioReviewThread }>(
    `/api/assistant/creative-studio/reviews?${query.toString()}`,
    undefined,
    'studio_review_failed',
  )
  return data.review
}

export type StudioReviewQueueClientItem = {
  projectAssetId: string
  projectId: string
  brandProfileId: string
  currentVersionId: string
  expectedSequence: number
  state: StudioReviewState
  title: string | null
  previewUrl: string | null
}

export async function fetchStudioReviewQueue(input: {
  brandProfileId: string
  projectId?: string | null
  cursor?: string | null
  includeApproved?: boolean
}): Promise<{
  items: StudioReviewQueueClientItem[]
  nextCursor: string | null
}> {
  const query = new URLSearchParams({ brandProfileId: input.brandProfileId })
  if (input.projectId) query.set('projectId', input.projectId)
  if (input.cursor) query.set('cursor', input.cursor)
  if (input.includeApproved) query.set('includeApproved', 'true')
  return studioRequest(
    `/api/assistant/creative-studio/reviews?${query.toString()}`,
    undefined,
    'studio_review_queue_failed',
  )
}

export async function addStudioReviewComment(input: {
  assetId: string
  brandProfileId: string
  comment: string
}): Promise<StudioReviewThread> {
  const data = await studioRequest<{ review: StudioReviewThread }>(
    '/api/assistant/creative-studio/reviews',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, intent: 'comment' }),
    },
    'studio_review_comment_failed',
  )
  return data.review
}

export async function transitionStudioReview(input: {
  assetId: string
  brandProfileId: string
  targetState: StudioReviewState
  expectedSequence: number
  note?: string
  compositionId?: string
  compositionVersionId?: string
}): Promise<StudioReviewThread> {
  const data = await studioRequest<{ review: StudioReviewThread }>(
    `/api/assistant/creative-studio/assets/${encodeURIComponent(input.assetId)}/state`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandProfileId: input.brandProfileId,
        targetState: input.targetState,
        expectedSequence: input.expectedSequence,
        note: input.note,
        compositionId: input.compositionId,
        compositionVersionId: input.compositionVersionId,
      }),
    },
    'studio_review_transition_failed',
  )
  return data.review
}

export async function authorizeStudioSpend(input: {
  assetId: string
  brandProfileId: string
  estimatedCostBdt: number
}): Promise<{
  authorized: true
  role: StudioAccessRole
  estimatedCostBdt: number
  approvalSpendThresholdBdt: number
}> {
  return studioRequest(
    '/api/assistant/creative-studio/reviews',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, intent: 'authorize_spend' }),
    },
    'studio_spend_authorization_failed',
  )
}

export type StudioConfig = {
  fashnConfigured: boolean
  geminiConfigured: boolean
  veoConfigured: boolean
  genericImageModels: { standard: string; pro: string }
  genericImageProvider: 'gemini' | 'openai' | 'fal'
  /** CS5 — FAL_KEY present on the server (foundation; engines runnable from CS6/CS7) */
  falConfigured: boolean
  /** CS13 — XAI_API_KEY present on the server (Grok Imagine engine) */
  xaiConfigured: boolean
  /** CS5 — registry availability snapshot (identity/status/flags, truthful when key missing) */
  engines: EngineAvailability[]
  /** CS5 — owner default for single-person Try-On (used from CS6) */
  singleVtonDefault: StudioEngineId
  /** honest label for multi-person family renders (FASHN + Gemini chain) */
  familyChainLabelBn: string
  organization: string
}

export type GalleryItem = {
  id: string
  /** Canonical access-scoped project lineage; absent only on legacy responses. */
  projectAssetId?: string | null
  assetVersionId?: string | null
  reviewSequence?: number | null
  projectId?: string | null
  brandProfileId?: string | null
  type: string
  status: string
  assetState: StudioAssetState
  publishable: boolean
  summary: string | null
  createdAt: string
  mode: string
  provider: string
  familyPreset: string | null
  /** CS6 — truthful engine lineage (fal VTON runs) */
  engine?: string | null
  imageModel?: string | null
  referenceReceipt?: {
    expectedCount: number
    sentCount: number
    roles: string[]
    allRequiredSent: boolean
  } | null
  endpointId?: string | null
  requestId?: string | null
  seed?: number | null
  latencyMs?: number | null
  costUsd?: number | null
  researchOnly?: boolean
  qc?: {
    pass?: boolean
    overall?: number
    attempts?: number
    flagged?: string
  } | null
  /** CS10 — plain-Bangla QC/protection summary for the lightbox */
  qcDetailsBn?: string | null
  maskPreset?: string | null
  memberCount?: number | null
  previewUrl: string | null
  /** small webp for the grid tile (falls back to previewUrl) */
  thumbUrl?: string | null
  /** branded variant (logo + code + hook), when produced */
  brandedUrl?: string | null
  /** Immutable decoded-byte evidence from the provider callback. */
  resolutionIntegrity?: Record<string, unknown> | null
  variants?: StudioArtifactDescriptor[]
  originalVariant?: StudioArtifactDescriptor | null
  /** Fixed-size social derivative; never presented as the full-resolution original. */
  brandedVariant?: StudioArtifactDescriptor | null
  storagePath: string | null
  /** V2: reel cover picker options (video_edit items) */
  coverOptions?: Array<{ path: string; url: string }>
  /** CS4: role when this image is an AI-generated brand model portrait */
  modelCreator?: string | null
  /** Last finishing inputs, used when reopening the editor. */
  finishParams?: Record<string, unknown> | null
  error: string | null
}

/** The brand identity is the single source of truth — logo + colours + fonts live
 * in BRAND / BrandAsset and are applied by applyBrandFrame. The owner only manages
 * the logo here; code + hook are entered PER IMAGE at finishing time. */
export type BrandStatus = {
  hasLogo: boolean
  logoUrl: string | null
  themes: string[]
  brandName: string
}

export type FinishMode = 'model_overlay' | 'product_card' | 'lifestyle'

export type StudioAssetScope = {
  brandProfileId: string
  projectId: string
  projectAssetId: string
}

export type FinishOptions = {
  storagePath: string
  /** for 'lifestyle' this is the big headline; other modes treat it as the hook */
  hook: string
  productCode?: string
  productName?: string
  price?: string
  /** lifestyle: small line above the headline (blank → brand "নতুন এসেছে") */
  eyebrow?: string
  /** lifestyle: bottom-right call-to-action (blank → brand default) */
  offer?: string
  mode?: FinishMode
  theme?: string
  footer?: boolean
  /** lifestyle only: 'contain' keeps the whole photo (no crop); default 'cover' */
  fit?: 'cover' | 'contain'
  /** lifestyle only: geometry tweaks from the drag/resize editor (positions/sizes) */
  layout?: LifestyleLayoutOverrides | null
  /** when finishing a gallery item, persist the framed copy back onto it */
  pendingActionId?: string
  /** V3 canonical lineage; the server re-resolves every relationship. */
  brandProfileId?: string
  projectId?: string
  projectAssetId?: string
}

export async function fetchBrandStatus(): Promise<BrandStatus> {
  return studioRequest<BrandStatus>('/api/assistant/creative-studio/branding', undefined, 'brand_status_failed')
}

/** Upload / replace the ALMA logo (auto-resized server-side). Stored in BrandAsset. */
export async function saveBrandLogo(logo: File, transparent = true): Promise<BrandStatus> {
  const fd = new FormData()
  fd.append('logo', logo)
  fd.append('transparent', transparent ? '1' : '0')
  return studioRequest<BrandStatus>('/api/assistant/creative-studio/branding', { method: 'POST', body: fd }, 'logo_save_failed')
}

/** Apply the deterministic brand frame (logo + this image's code + hook). */
export async function finishImage(opts: FinishOptions): Promise<{
  framedPath: string
  framedUrl: string
  brandedVariant: StudioArtifactDescriptor
}> {
  return studioRequest<{
    framedPath: string
    framedUrl: string
    brandedVariant: StudioArtifactDescriptor
  }>(
    '/api/assistant/creative-studio/finish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    },
    'finish_failed',
  )
}

export type RunPayload = {
  mode: StudioModeId
  provider?: StudioProvider
  /** CS6 — single Try-On engine choice (fashn / gemini / fal_fashn_v16 / fal_idm_vton) */
  vtonEngine?: StudioEngineId
  /** CS6 — owner override for garment placement when auto classification is uncertain */
  clothType?: 'auto' | 'overall' | 'upper' | 'lower' | 'outer'
  /** CS9 — family protected compositing (approved people, no regen merge) */
  protectedComposite?: boolean
  /** CS7 — FLUX Fill precision edit fields (Edit mode only) */
  maskPath?: string
  maskPreset?: string
  baseWidth?: number
  baseHeight?: number
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
  secondSourceImagePath?: string
  faceReferencePath?: string
  modelId?: string
  familyPreset?: FamilyPresetId
  prompt?: string
  backgroundPrompt?: string
  aspectRatio?: string
  resolution?: FashnResolution
  generationMode?: FashnGenerationMode
  numImages?: number
  durationSec?: number
  vibe?: 'premium' | 'festival' | 'offer' | 'lifestyle'
  /** Gallery source id — lets the server enforce the QC action gate. */
  sourcePendingActionId?: string
  /** Canonical server-enforced Creative Studio scope. */
  brandProfileId?: string
  projectId?: string
  productId?: string
  sourceAssetIds?: string[]
  studioSurface?: 'v3' | 'legacy'
}

export type StudioRunEstimateClient = {
  receipt: string
  receiptId: string
  confirmBy: string
  estimateBdt: number
  estimateUsd: number
  maxCostBdt: number
  requestFingerprint: string
  selectionFingerprint: string
  selection: {
    mode: string
    architecture: 'auto' | 'advanced'
    provider: string
    model: string
    providers: string[]
    models: string[]
    plan: string[]
    paidAttemptLimit: number
  }
  confirmationRequired: true
  providerCallMade: false
}

export async function fetchStudioConfig(): Promise<StudioConfig> {
  return studioRequest<StudioConfig>('/api/assistant/creative-studio/config', undefined, 'config_failed')
}

/**
 * Preserve reference pixels whenever the server can accept the original.
 * HEIC/oversize files are converted only as much as the 10 MB upload boundary
 * requires; unlike the former implementation this does not cap every image at
 * 2048 px or recompress ordinary PNG/JPEG/WebP references.
 */
async function prepareImageForUpload(file: File): Promise<File> {
  const looksImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)
  if (!looksImage || typeof document === 'undefined') return file
  const heic = /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
  const TARGET_BYTES = 9.5 * 1024 * 1024
  if (!heic && file.size <= TARGET_BYTES) return file
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    let scale = 1
    let blob: Blob | null = null
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const quality = Math.max(0.82, 0.95 - attempt * 0.025)
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality))
      if (blob && blob.size <= TARGET_BYTES) break
      scale *= 0.88
    }
    bitmap.close?.()
    if (!blob) return file
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export type DriveStatus = {
  configured: boolean
  connected: boolean
  email: string | null
  connectedAt: string | null
}

export async function fetchDriveStatus(): Promise<DriveStatus> {
  return studioRequest<DriveStatus>('/api/assistant/creative-studio/drive-status', undefined, 'drive_status_failed')
}

export async function disconnectDrive(): Promise<void> {
  await studioRequest<unknown>('/api/assistant/creative-studio/drive-status', { method: 'DELETE' }, 'drive_disconnect_failed')
}

/** Full-page redirect into Google's consent screen (one-time connect). */
export function connectDriveUrl(): string {
  return '/api/assistant/creative-studio/drive-auth'
}

export async function uploadStudioFile(file: File, folder: string): Promise<string> {
  const prepared = await prepareImageForUpload(file)
  const fd = new FormData()
  fd.append('file', prepared)
  fd.append('conversationId', folder)
  const data = await studioRequest<{ path: string }>('/api/assistant/upload', { method: 'POST', body: fd }, 'upload_failed')
  return data.path
}

/** CS7 — upload a painted FLUX Fill mask; server validates dims vs base + coverage. */
export async function uploadFillMask(
  maskBlob: Blob,
  basePath: string,
  scope?: {
    brandProfileId: string
    projectId: string
    projectAssetId: string
    pendingActionId: string
  },
): Promise<{
  maskPath: string
  width: number
  height: number
  coveragePct: number
  estimatedCostUsd: number
}> {
  const fd = new FormData()
  fd.append('mask', new File([maskBlob], 'mask.png', { type: 'image/png' }))
  fd.append('basePath', basePath)
  if (scope) {
    fd.append('brandProfileId', scope.brandProfileId)
    fd.append('projectId', scope.projectId)
    fd.append('projectAssetId', scope.projectAssetId)
    fd.append('pendingActionId', scope.pendingActionId)
  }
  return studioRequest<{
    maskPath: string
    width: number
    height: number
    coveragePct: number
    estimatedCostUsd: number
  }>('/api/assistant/creative-studio/mask-upload', { method: 'POST', body: fd }, 'mask_upload_failed')
}

function scopedRunPayload<T extends RunPayload | (RunPayload & { auto: true })>(payload: T): T {
  const context = activeContentContext
  return {
    ...payload,
    brandProfileId: payload.brandProfileId ?? context?.brandProfileId,
    projectId: payload.projectId ?? context?.projectId,
    productId: payload.productId ?? context?.productId ?? undefined,
    studioSurface: payload.studioSurface ?? 'legacy',
  }
}

export async function estimateStudioJob(
  payload: RunPayload & { auto?: boolean; includeFamily?: boolean; includeReel?: boolean },
  maxCostBdt = 500,
): Promise<StudioRunEstimateClient> {
  return studioRequest<StudioRunEstimateClient>(
    '/api/assistant/creative-studio/run',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...scopedRunPayload(payload),
        intent: 'estimate',
        maxCostBdt,
      }),
    },
    'run_estimate_failed',
  )
}

export async function confirmStudioJob(
  payload: RunPayload & { auto?: boolean; includeFamily?: boolean; includeReel?: boolean },
  estimate: StudioRunEstimateClient,
  input: { maxCostBdt: number; idempotencyKey?: string },
) {
  const result = await studioRequest<{
    jobs: Array<{ pendingActionId: string; label: string }>
    provider: string
    actualModel?: string
    message: string
  }>(
    '/api/assistant/creative-studio/run',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...scopedRunPayload(payload),
        intent: 'confirm',
        receipt: estimate.receipt,
        confirmed: true,
        idempotencyKey: input.idempotencyKey ?? `studio:${estimate.receiptId}`,
        maxCostBdt: input.maxCostBdt,
      }),
    },
    'run_failed',
  )
  await linkQueuedStudioJobs(result.jobs, payload.sourcePendingActionId ? [payload.sourcePendingActionId] : [])
  return result
}

/**
 * Legacy compatibility: the caller's existing confirmation button invokes
 * this method once; the client still performs the mandatory estimate request
 * and a distinct receipt-bound confirm request. V3 uses the two methods above
 * directly so the exact server estimate is visible before confirmation.
 */
export async function runStudioJob(payload: RunPayload) {
  const estimate = await estimateStudioJob(payload)
  return confirmStudioJob(payload, estimate, { maxCostBdt: estimate.maxCostBdt })
}

export async function runAutoStudioJob(input: {
  productImagePath: string
  modelId?: string
  includeFamily?: boolean
  includeReel?: boolean
  brandProfileId?: string
  projectId?: string
  productId?: string
  studioSurface?: 'v3' | 'legacy'
}) {
  const payload = { auto: true as const, mode: 'try_on' as const, ...input }
  const estimate = await estimateStudioJob(payload)
  return confirmStudioJob(payload, estimate, { maxCostBdt: estimate.maxCostBdt })
}

export type GalleryQuery = {
  cursor?: string | null
  page?: number
  media?: GalleryMediaFilter
  state?: GalleryStateFilter
  qc?: GalleryQcFilter
  query?: string
  includeTest?: boolean
  limit?: number
  brandProfileId?: string | null
  projectId?: string | null
  archived?: boolean
  projectAssetId?: string | null
  assetVersionId?: string | null
  reviewSequence?: number | null
}

export type GalleryPage = {
  items: GalleryItem[]
  hasMore: boolean
  total: number
  nextCursor: string | null
}

export async function fetchGallery(input: GalleryQuery | number = {}): Promise<GalleryPage> {
  const query: GalleryQuery = typeof input === 'number' ? { page: input } : input
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 24))
  if (query.cursor) params.set('cursor', query.cursor)
  else if (query.page && query.page > 1) params.set('page', String(query.page))
  if (query.media && query.media !== 'all') params.set('media', query.media)
  if (query.state && query.state !== 'all') params.set('state', query.state)
  if (query.qc && query.qc !== 'all') params.set('qc', query.qc)
  if (query.query?.trim()) params.set('q', query.query.trim())
  if (query.includeTest) params.set('includeTest', '1')
  if (query.brandProfileId) params.set('brandProfileId', query.brandProfileId)
  if (query.projectId) params.set('projectId', query.projectId)
  if (query.archived) params.set('archived', '1')
  if (query.projectAssetId) params.set('projectAssetId', query.projectAssetId)
  if (query.assetVersionId) params.set('assetVersionId', query.assetVersionId)
  if (Number.isInteger(query.reviewSequence)) {
    params.set('reviewSequence', String(query.reviewSequence))
  }
  return studioRequest<GalleryPage>(`/api/assistant/creative-studio/gallery?${params.toString()}`, undefined, 'gallery_failed')
}

export type SavedStudioModel = {
  id: string
  name: string
  role: string | null
  isDefault: boolean
  /** raw storage object path (private) */
  imagePath?: string
  /** signed, ready-to-render URL for the saved photo (1h) */
  imageUrl?: string | null
  /** CS14 — avatar status (multi-angle identity) */
  avatar?: { built: boolean; building: boolean; count: number } | null
}

export async function fetchModels(brandProfileId?: string | null, projectId?: string | null) {
  const query = new URLSearchParams()
  if (brandProfileId) query.set('brandProfileId', brandProfileId)
  if (projectId) query.set('projectId', projectId)
  const suffix = query.size ? `?${query.toString()}` : ''
  return studioRequest<{ models: SavedStudioModel[] }>(`/api/assistant/brand-models${suffix}`, undefined, 'models_failed')
}

// ── CS14: Model Avatar (multi-angle identity) ───────────────────────────────

export type StudioModelAvatar = {
  imagePaths: string[]
  imageUrls: (string | null)[]
  sheetPath?: string
  sheetUrl?: string | null
  canonicalPath?: string
  canonicalUrl?: string | null
  builtAt?: string
  building?: boolean
}

export async function fetchAvatar(modelId: string) {
  return studioRequest<{ avatar: StudioModelAvatar | null }>(
    `/api/assistant/brand-models/avatar?id=${encodeURIComponent(modelId)}`,
    undefined,
    'avatar_failed',
  )
}

export async function setAvatarImages(modelId: string, imagePaths: string[]) {
  return studioRequest<{ ok: true; count: number; max: number }>(
    '/api/assistant/brand-models/avatar',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_images', id: modelId, imagePaths }),
    },
    'avatar_save_failed',
  )
}

export async function buildAvatar(modelId: string, canonical: boolean) {
  return studioRequest<{ ok: true; pendingActionId: string }>(
    '/api/assistant/brand-models/avatar',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'build', id: modelId, canonical }),
    },
    'avatar_build_failed',
  )
}

export async function clearAvatarImages(modelId: string) {
  await studioRequest<unknown>(
    '/api/assistant/brand-models/avatar',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear', id: modelId }),
    },
    'avatar_clear_failed',
  )
}

/** Make one saved model the default the Auto tab uses (per-image select stays manual). */
export async function setDefaultModel(id: string) {
  const context = getActiveStudioContentContext()
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'set_default',
        id,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'set_default_failed',
  )
}

/** Remove a saved model from the library. */
export async function deleteModel(id: string) {
  const context = getActiveStudioContentContext()
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remove',
        id,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'delete_failed',
  )
}

// ── Phase V1: owner-shot video → deterministic recipe reels ─────────────────

export type StudioVideoUpload = {
  id: string
  path: string
  name: string
  sizeBytes: number
  uploadedAt: string
}

export type VideoJobStatus = {
  id: string
  status: string
  summary: string | null
  previewUrl: string | null
  storagePath: string | null
  videoProgress: { step: number; total: number; labelBn: string } | null
  error: string | null
}

export async function fetchStudioVideos(
  brandProfileId?: string | null,
  projectId?: string | null,
): Promise<StudioVideoUpload[]> {
  const query = new URLSearchParams()
  if (brandProfileId) query.set('brandProfileId', brandProfileId)
  if (projectId) query.set('projectId', projectId)
  const data = await studioRequest<{ uploads?: StudioVideoUpload[] }>(
    `/api/assistant/creative-studio/video${query.size ? `?${query.toString()}` : ''}`,
    undefined,
    'videos_failed',
  )
  return (data.uploads ?? []) as StudioVideoUpload[]
}

/**
 * Big phone shoots (up to ~500 MB) go STRAIGHT to Supabase storage with a
 * signed upload URL — Vercel never sees the body. XHR (not fetch) so the owner
 * gets a real progress bar on a multi-minute upload.
 */
export async function uploadStudioVideo(file: File, onProgress?: (pct: number) => void): Promise<StudioVideoUpload> {
  const context = getActiveStudioContentContext()
  const urlData = await studioRequest<{
    uploadUrl: string
    uploadId: string
    path: string
    contentType?: string
  }>(
    '/api/assistant/creative-studio/video/upload-url',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
    },
    'upload_url_failed',
  )

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', urlData.uploadUrl)
    xhr.setRequestHeader('Content-Type', urlData.contentType ?? file.type ?? 'video/mp4')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_failed_${xhr.status}`)))
    xhr.onerror = () => reject(new Error('upload_network_error'))
    xhr.send(file)
  })

  const regData = await studioRequest<{ upload: StudioVideoUpload }>(
    '/api/assistant/creative-studio/video',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: urlData.uploadId,
        path: urlData.path,
        name: file.name,
        sizeBytes: file.size,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'register_failed',
  )
  return regData.upload as StudioVideoUpload
}

export async function deleteStudioVideo(id: string): Promise<void> {
  const context = getActiveStudioContentContext()
  const query = new URLSearchParams({ id })
  if (context) {
    query.set('brandProfileId', context.brandProfileId)
    query.set('projectId', context.projectId)
  }
  await studioRequest<unknown>(`/api/assistant/creative-studio/video?${query.toString()}`, { method: 'DELETE' }, 'delete_failed')
}

export type StudioMusicTrack = {
  id: string
  path: string
  name: string
  vibe: string
  sizeBytes: number
  uploadedAt: string
}

export async function fetchMusicTracks(
  brandProfileId?: string | null,
  projectId?: string | null,
): Promise<StudioMusicTrack[]> {
  const query = new URLSearchParams()
  if (brandProfileId) query.set('brandProfileId', brandProfileId)
  if (projectId) query.set('projectId', projectId)
  const data = await studioRequest<{ tracks?: StudioMusicTrack[] }>(
    `/api/assistant/creative-studio/music${query.size ? `?${query.toString()}` : ''}`,
    undefined,
    'music_failed',
  )
  return (data.tracks ?? []) as StudioMusicTrack[]
}

/** Owner-approved music beds only — uploaded from his own files, signed direct upload. */
export async function uploadMusicTrack(file: File, vibe: string, onProgress?: (pct: number) => void): Promise<StudioMusicTrack> {
  const context = getActiveStudioContentContext()
  const urlData = await studioRequest<{
    uploadUrl: string
    uploadId: string
    path: string
    contentType?: string
  }>(
    '/api/assistant/creative-studio/music/upload-url',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
    },
    'upload_url_failed',
  )

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', urlData.uploadUrl)
    xhr.setRequestHeader('Content-Type', urlData.contentType ?? file.type ?? 'audio/mpeg')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_failed_${xhr.status}`)))
    xhr.onerror = () => reject(new Error('upload_network_error'))
    xhr.send(file)
  })

  const regData = await studioRequest<{ track: StudioMusicTrack }>(
    '/api/assistant/creative-studio/music',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: urlData.uploadId,
        path: urlData.path,
        name: file.name,
        vibe,
        sizeBytes: file.size,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'register_failed',
  )
  return regData.track as StudioMusicTrack
}

export async function deleteMusicTrack(id: string): Promise<void> {
  const context = getActiveStudioContentContext()
  const query = new URLSearchParams({ id })
  if (context) {
    query.set('brandProfileId', context.brandProfileId)
    query.set('projectId', context.projectId)
  }
  await studioRequest<unknown>(`/api/assistant/creative-studio/music?${query.toString()}`, { method: 'DELETE' }, 'delete_failed')
}

/** Set a reel's cover from the worker's candidate frames. */
export async function setReelCover(pendingActionId: string, coverPath: string): Promise<{ thumbUrl: string | null }> {
  return studioRequest<{ thumbUrl: string | null }>(
    '/api/assistant/creative-studio/video/cover',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingActionId, coverPath }),
    },
    'cover_failed',
  )
}

export type VideoFinishTemplates = {
  pricePop?: { price: string }
  lowerThird?: { code: string; name?: string }
  logoWatermark?: boolean
  endCard?: { cta?: string; code?: string; price?: string }
  countdown?: { days: number }
}

/** V3: queue motion-template finishing for a rendered reel. */
export async function finishVideo(
  pendingActionId: string,
  templates: VideoFinishTemplates,
  scope?: StudioAssetScope,
): Promise<{ pendingActionId: string; message: string }> {
  const result = await studioRequest<{ pendingActionId: string; message: string }>(
    '/api/assistant/creative-studio/video/finish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingActionId, templates, ...scope }),
    },
    'finish_failed',
  )
  await linkQueuedStudioJobs([result], [pendingActionId])
  return result
}

export type VideoEditSource = {
  pendingActionId: string
  durationSec: number
  sourcePath: string
  editContract: VideoEditContract | null
}

export async function fetchVideoEditSource(
  pendingActionId: string,
  scope?: StudioAssetScope,
): Promise<VideoEditSource> {
  const query = new URLSearchParams({ pendingActionId })
  if (scope) {
    query.set('brandProfileId', scope.brandProfileId)
    query.set('projectId', scope.projectId)
    query.set('projectAssetId', scope.projectAssetId)
  }
  return studioRequest<VideoEditSource>(
    `/api/assistant/creative-studio/video/finish?${query.toString()}`,
    undefined,
    'video_edit_source_failed',
  )
}

export async function partiallyFinishVideo(
  pendingActionId: string,
  editContract: VideoEditContract,
  scope?: StudioAssetScope,
): Promise<{ pendingActionId: string; message: string }> {
  const result = await studioRequest<{ pendingActionId: string; message: string }>(
    '/api/assistant/creative-studio/video/finish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingActionId, mode: 'partial_edit', editContract, ...scope }),
    },
    'partial_finish_failed',
  )
  await linkQueuedStudioJobs([result], [pendingActionId])
  return result
}

// ── CSE5 Audio Lab + voice lifecycle helpers ────────────────────────────────

export type AudioLabStatus = {
  voiceCloned: boolean
  activeVoiceVersionId: string | null
  activeVoiceVersion: number | null
  legacyVoiceAvailable: boolean
  styles: Array<{ id: string; labelBn: string }>
  occasions: Array<{ id: string; labelBn: string }>
  maxCostBdt: number
}

export async function fetchAudioLabStatus(): Promise<AudioLabStatus> {
  return studioRequest<AudioLabStatus>('/api/assistant/creative-studio/audio', undefined, 'audio_status_failed')
}

export type AudioJobEstimate = {
  requiresConfirmation: true
  summary: string
  provider: string
  costBdt: number
  maxCostBdt: number
  ceilingUsd?: number
}

function withOwnerVoiceContext(body: Record<string, unknown>): Record<string, unknown> {
  return body.kind === 'owner_voice' || body.kind === 'voice_change'
    ? { ...body, usageContext: 'owner_studio' }
    : body
}

export async function estimateAudioJob(body: Record<string, unknown>): Promise<AudioJobEstimate> {
  return studioRequest<AudioJobEstimate>(
    '/api/assistant/creative-studio/audio',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...withOwnerVoiceContext(body), intent: 'estimate' }),
    },
    'audio_estimate_failed',
  )
}

export async function queueAudioJob(body: Record<string, unknown>, confirmation: { confirmedCostBdt: number; costCapBdt: number }) {
  const result = await studioRequest<{
    pendingActionId: string
    costBdt: number
    maxCostBdt: number
  }>(
    '/api/assistant/creative-studio/audio',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...withOwnerVoiceContext(body), intent: 'queue', ...confirmation }),
    },
    'audio_failed',
  )
  await linkQueuedStudioJobs([result])
  return result
}

export async function uploadAudioFile(file: File, onProgress?: (pct: number) => void): Promise<string> {
  const urlData = await studioRequest<{
    uploadUrl: string
    path: string
    contentType?: string
  }>(
    '/api/assistant/creative-studio/audio/upload-url',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
    },
    'upload_url_failed',
  )
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', urlData.uploadUrl)
    xhr.setRequestHeader('Content-Type', urlData.contentType ?? file.type ?? 'audio/mpeg')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_failed_${xhr.status}`)))
    xhr.onerror = () => reject(new Error('upload_network_error'))
    xhr.send(file)
  })
  return urlData.path as string
}

export type CreativeVoiceVersionClient = {
  id: string
  version: number
  status: string
  providerReady: boolean
  consentRecordedAt: string
  consentSha256: string
  activatedAt: string | null
  revokedAt: string | null
  providerDeletedAt: string | null
  createdAt: string
}

export type CreativeVoiceAuditClient = {
  id: string
  voiceVersionId: string | null
  action: string
  reason: string | null
  createdAt: string
}

export type CreativeVoiceClient = {
  id: string
  name: string
  provider: string
  ownerOnly: true
  activeVersionId: string | null
  versions: CreativeVoiceVersionClient[]
  audits: CreativeVoiceAuditClient[]
}

export async function fetchCreativeVoices(
  brandProfileId?: string | null,
  projectId?: string | null,
): Promise<CreativeVoiceClient[]> {
  const query = new URLSearchParams()
  if (brandProfileId) query.set('brandProfileId', brandProfileId)
  if (projectId) query.set('projectId', projectId)
  const result = await studioRequest<{ voices: CreativeVoiceClient[] }>(
    `/api/assistant/creative-studio/voices${query.size ? `?${query.toString()}` : ''}`,
    undefined,
    'voices_failed',
  )
  return result.voices ?? []
}

export async function estimateVoiceClone(input: {
  name: string
  samplePaths: string[]
  consent: { accepted: true; statement: string }
}): Promise<AudioJobEstimate> {
  const context = getActiveStudioContentContext()
  return studioRequest<AudioJobEstimate>(
    '/api/assistant/creative-studio/voices',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input,
        intent: 'estimate',
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'voice_clone_estimate_failed',
  )
}

export async function queueVoiceClone(
  input: {
    name: string
    samplePaths: string[]
    consent: { accepted: true; statement: string }
  },
  confirmation: { confirmedCostBdt: number; costCapBdt: number },
) {
  const context = getActiveStudioContentContext()
  const result = await studioRequest<{
    pendingActionId: string
    voiceVersionId: string
    costBdt: number
  }>(
    '/api/assistant/creative-studio/voices',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...input,
        intent: 'queue',
        ...confirmation,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'voice_clone_failed',
  )
  await linkQueuedStudioJobs([result])
  return result
}

export async function updateVoiceVersion(
  voiceVersionId: string,
  action: 'activate' | 'revoke',
  reason?: string,
) {
  return studioRequest<{ ok: true; status: string }>(
    `/api/assistant/creative-studio/voices/${encodeURIComponent(voiceVersionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    },
    'voice_update_failed',
  )
}

export async function deleteVoiceVersion(voiceVersionId: string, reason?: string) {
  const result = await studioRequest<{ ok: true; pendingActionId: string | null; status: string }>(
    `/api/assistant/creative-studio/voices/${encodeURIComponent(voiceVersionId)}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
    'voice_delete_failed',
  )
  if (result.pendingActionId) await linkQueuedStudioJobs([{ pendingActionId: result.pendingActionId }])
  return result
}

// ── CS4 helpers ──────────────────────────────────────────────────────────────

export async function sendItemFeedback(pendingActionId: string, verdict: 'good' | 'bad') {
  return studioRequest<{ weighted: boolean; weight?: number }>(
    '/api/assistant/creative-studio/feedback',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingActionId, verdict }),
    },
    'feedback_failed',
  )
}

export async function retryStudioJob(pendingActionId: string) {
  const result = await studioRequest<{ pendingActionId: string }>(
    `/api/assistant/creative-studio/jobs/${pendingActionId}/retry`,
    { method: 'POST' },
    'retry_failed',
  )
  await linkQueuedStudioJobs([result], [pendingActionId])
  return result
}

export type StudioSettings = {
  qcLevel: 'off' | 'normal' | 'strict'
  notifyOnDone: boolean
  /** Which model family renders images: Nano Banana (default) or GPT Image 2. */
  imageEngine: 'gemini' | 'gpt' | 'seedream'
  sceneWeights: Record<string, number>
  childGarments: Array<{
    key: string
    role: string
    productPath: string
    garmentPath: string
    url: string | null
  }>
  /** CS5 — Fal foundation flags (default OFF; engines runnable from CS6/CS7) */
  falEnabled: boolean
  idmVtonEnabled: boolean
  fluxFillEnabled: boolean
  /** CS13 — xAI Grok Imagine master switch */
  xaiEnabled: boolean
  singleVtonDefault: StudioEngineId
  /** CS8 — Preview (১টি সাশ্রয়ী রান) vs Production (কড়া QC + bounded repair) */
  pipelineMode: 'preview' | 'production'
}

export async function fetchStudioSettings(): Promise<StudioSettings> {
  return studioRequest<StudioSettings>('/api/assistant/creative-studio/settings', undefined, 'settings_failed')
}

export async function saveStudioSettings(patch: {
  qcLevel?: string
  notifyOnDone?: boolean
  imageEngine?: 'gemini' | 'gpt' | 'seedream'
  falEnabled?: boolean
  idmVtonEnabled?: boolean
  fluxFillEnabled?: boolean
  xaiEnabled?: boolean
  singleVtonDefault?: StudioEngineId
  pipelineMode?: 'preview' | 'production'
}) {
  await studioRequest<unknown>(
    '/api/assistant/creative-studio/settings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
    'settings_save_failed',
  )
}

export async function deleteGarmentCache(key: string) {
  await studioRequest<unknown>(
    `/api/assistant/creative-studio/settings?key=${encodeURIComponent(key)}`,
    { method: 'DELETE' },
    'cache_delete_failed',
  )
}

// ── CS12: engine health + kill switches ─────────────────────────────────────

export type StudioHealth = {
  windowDays: number
  engines: Array<{
    engine: string
    labelBn: string
    jobs: number
    failed: number
    errorRatePct: number
    qcPassRatePct: number | null
    p50LatencyMs: number | null
    p95LatencyMs: number | null
    spendUsd: number
    killed: boolean
  }>
  kills: Record<string, boolean>
  canaryPct: number
  worker: {
    state: 'healthy' | 'delayed' | 'offline' | 'unknown'
    labelBn: string
    heartbeatAt: string | null
    heartbeatAgeSec: number | null
    lastSeenBn: string
    healthy: boolean
  }
  turnConsumer: {
    state: 'healthy' | 'delayed' | 'offline' | 'unknown'
    labelBn: string
    heartbeatAt: string | null
    heartbeatAgeSec: number | null
    lastSeenBn: string
    healthy: boolean
  }
  balances: Array<{
    id: string
    label: string
    balanceUsd: number | null
    monthUsd: number | null
  }>
}

export async function fetchStudioHealth(): Promise<StudioHealth> {
  return studioRequest<StudioHealth>('/api/assistant/creative-studio/health', undefined, 'health_failed')
}

export async function setEngineKill(id: string, killed: boolean): Promise<void> {
  await studioRequest<unknown>(
    '/api/assistant/creative-studio/settings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killEngine: { id, killed } }),
    },
    'kill_save_failed',
  )
}

// ── CS10: golden evaluation helpers ─────────────────────────────────────────

export type GoldenEvalSummary = {
  cases: Array<{ id: string; garmentType: string; modelRole: string }>
  runs: Array<{
    runId: string
    finishedAt: string
    attempts: number
    totalCostUsd: number
  }>
  comparison: {
    rankings: Array<{ engine: string; score: number; reasonBn: string }>
    recommended: string | null
    verdictBn: string
  } | null
}

export async function fetchGoldenEval(): Promise<GoldenEvalSummary> {
  return studioRequest<GoldenEvalSummary>('/api/assistant/creative-studio/evaluations', undefined, 'eval_fetch_failed')
}

export async function runGoldenEvalNow(): Promise<{
  runId: string
  estimatedCostUsd: number
}> {
  return studioRequest<{ runId: string; estimatedCostUsd: number }>(
    '/api/assistant/creative-studio/evaluations',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'run' }),
    },
    'eval_run_failed',
  )
}

export async function generateBrandModel(role: string) {
  return studioRequest<{ pendingActionId: string }>(
    '/api/assistant/creative-studio/model-creator',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    },
    'model_gen_failed',
  )
}

export type VideoRunOptions = {
  captions?: boolean
  audioMode?: 'original' | 'music' | 'music_duck'
  musicTrackId?: string
  voiceoverText?: string
  stings?: boolean
  aiAssist?: boolean
}

export async function runVideoRecipe(body: {
  videoPath: string
  videoName: string
  recipeId: string
  targets: number[]
  aspect: string
  options?: VideoRunOptions
}): Promise<{
  jobs: Array<{ pendingActionId: string; label: string; targetSec: number }>
  message: string
}> {
  const result = await studioRequest<{
    jobs: Array<{ pendingActionId: string; label: string; targetSec: number }>
    message: string
  }>(
    '/api/assistant/creative-studio/video/run',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    'run_failed',
  )
  await linkQueuedStudioJobs(result.jobs)
  return result
}

export async function fetchVideoJob(id: string): Promise<VideoJobStatus> {
  return studioRequest<VideoJobStatus>(`/api/assistant/creative-studio/jobs/${id}`, undefined, 'job_failed')
}

export async function saveModel(body: { id: string; name: string; imagePath: string; role: string; notes?: string }) {
  const context = getActiveStudioContentContext()
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        ...body,
        ...(context
          ? {
              brandProfileId: context.brandProfileId,
              projectId: context.projectId,
            }
          : {}),
      }),
    },
    'save_failed',
  )
}

// ── CSE7: approved distribution, attribution, and retention ────────────────

export type StudioPublishPlatform = 'facebook' | 'instagram'
export type StudioPublishStatus =
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed_retryable'
  | 'needs_review'
  | 'canceled'

export type StudioPublishInput = {
  assetId: string
  brandProfileId: string
  platform: StudioPublishPlatform
  pageRef: 'lifestyle' | 'onlineshop'
  caption: string
  scheduledFor: string
  idempotencyKey: string
  adId?: string
}

export type StudioPublishPreview = StudioPublishInput & {
  dryRun: true
  requestFingerprint: string
  assetVersionId: string
  approvedReviewEventId: string
  projectId: string
  campaignPackId: string | null
  sceneKey: string
  mediaStoragePath: string
  estimatedCostUsd: 0
  publishingEnabled: boolean
  receipt: {
    mode: 'dry_run'
    externalEffect: false
    approvedVersionPinned: true
    duplicateProtection: string
  }
}

export type StudioPublishDelivery = {
  id: string
  ownerId: string
  brandProfileId: string
  projectId: string
  assetId: string
  assetVersionId: string
  campaignPackId: string | null
  sceneKey: string
  platform: StudioPublishPlatform
  pageRef: string
  caption: string
  adId: string | null
  idempotencyKey: string
  status: StudioPublishStatus
  scheduledFor: string
  attempts: number
  externalPostId: string | null
  permalinkUrl: string | null
  verifiedAt: string | null
  publishedAt: string | null
  receipt: Record<string, unknown>
  lastErrorCode: string | null
  lastErrorMessage: string | null
  metricsLastSyncedAt: string | null
  metricsLastError: string | null
  costUsd: number
  createdAt: string
  updatedAt: string
}

export async function fetchStudioPublishDeliveries(
  assetId: string,
  brandProfileId: string,
): Promise<{
  deliveries: StudioPublishDelivery[]
  publishingEnabled: boolean
  canPublish: boolean
}> {
  const query = new URLSearchParams({ assetId, brandProfileId })
  return studioRequest(
    `/api/assistant/creative-studio/publish?${query.toString()}`,
    undefined,
    'publish_deliveries_failed',
  )
}

export async function previewStudioPublishClient(
  input: StudioPublishInput,
): Promise<StudioPublishPreview> {
  const data = await studioRequest<{ preview: StudioPublishPreview }>(
    '/api/assistant/creative-studio/publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'dry_run', ...input }),
    },
    'publish_preview_failed',
  )
  return data.preview
}

export async function scheduleStudioPublishClient(
  input: StudioPublishInput,
): Promise<{ delivery: StudioPublishDelivery; idempotent: boolean }> {
  return studioRequest(
    '/api/assistant/creative-studio/publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'schedule',
        ...input,
        confirmedOwnerApproval: true,
      }),
    },
    'publish_schedule_failed',
  )
}

export async function setStudioPublishingEnabledClient(
  brandProfileId: string,
  enabled: boolean,
): Promise<{ publishingEnabled: boolean }> {
  return studioRequest(
    '/api/assistant/creative-studio/publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'set_enabled', brandProfileId, enabled }),
    },
    'publish_setting_failed',
  )
}

export async function mutateStudioPublishDelivery(
  intent: 'cancel' | 'retry',
  deliveryId: string,
): Promise<StudioPublishDelivery> {
  const data = await studioRequest<{ delivery: StudioPublishDelivery }>(
    '/api/assistant/creative-studio/publish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, deliveryId }),
    },
    `publish_${intent}_failed`,
  )
  return data.delivery
}

export type StudioPerformanceDashboard = {
  scope: {
    brandProfileId: string
    projectId: string | null
    assetId: string | null
    role: StudioAccessRole
  }
  totals: {
    reach: number
    impressions: number
    engagements: number
    clicks: number
    conversions: number
  }
  deliveries: Array<{
    id: string
    assetId: string
    assetVersionId: string
    campaignPackId: string | null
    sceneKey: string
    platform: string
    status: string
    postId: string | null
    permalinkUrl: string | null
    latestSnapshot: null | {
      id: string
      deliveryId: string
      assetVersionId: string
      campaignPackId: string | null
      externalObjectId: string
      reach: number
      impressions: number
      engagements: number
      clicks: number
      conversions: number
      spendAmount: number | null
      spendCurrency: string | null
      revenueBdt: number | null
      capturedAt: string
    }
  }>
  weights: Array<{
    recipeId: string
    sceneKey: string
    weight: number
    sampleCount: number
    updatedAt: string
  }>
  observability: {
    queueAgeSec: number
    workerHeartbeatAt: string | null
    workerHeartbeatAgeSec: number | null
    providerErrorRatePct: number
    spendUsd7d: number
    qcRatePct7d: number | null
    archivePending: number
    archiveLagHours: number
    publishFailures7d: number
  }
}

export async function fetchStudioPerformance(input: {
  brandProfileId: string
  projectId?: string
  assetId?: string
}): Promise<StudioPerformanceDashboard> {
  const query = new URLSearchParams({ brandProfileId: input.brandProfileId })
  if (input.projectId) query.set('projectId', input.projectId)
  if (input.assetId) query.set('assetId', input.assetId)
  return studioRequest(
    `/api/assistant/creative-studio/performance?${query.toString()}`,
    undefined,
    'performance_failed',
  )
}

export type StudioRetentionDashboard = {
  policy: {
    archiveEnabled: boolean
    deleteOriginalsEnabled: boolean
    retentionDays: number
    verificationGraceHours: number
  }
  stats: {
    totalReceipts: number
    verifiedReceipts: number
    deletedOriginals: number
    failedReceipts: number
    oldestUnverifiedAgeHours: number
    lastRun: { at: string; detail: string } | null
  }
}

export async function fetchStudioRetention(): Promise<StudioRetentionDashboard> {
  return studioRequest(
    '/api/assistant/creative-studio/retention',
    undefined,
    'retention_failed',
  )
}

export async function saveStudioRetention(
  policy: StudioRetentionDashboard['policy'],
): Promise<StudioRetentionDashboard> {
  return studioRequest(
    '/api/assistant/creative-studio/retention',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    },
    'retention_save_failed',
  )
}

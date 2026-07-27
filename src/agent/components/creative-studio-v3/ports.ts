import type {
  CreativeStudioV3ReviewQueuePort,
} from '@/agent/components/creative-studio-v3/types'
import type {
  AudioLabStatus,
  CreativeVoiceClient,
  GalleryItem,
  GalleryPage,
  GalleryQuery,
  RunPayload,
  SavedStudioModel,
  StudioAssetScope,
  StudioBrandProfile,
  StudioConfig,
  StudioHealth,
  StudioMusicTrack,
  StudioRetentionDashboard,
  StudioReviewThread,
  StudioSettings,
  StudioRunEstimateClient,
  StudioVideoUpload,
  VideoEditSource,
  VideoFinishTemplates,
} from '@/agent/components/creative-studio/studio-api'
import type {
  StudioBrandRecipe,
  StudioProductOption,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import type { CreativeCompositionSummary } from '@/lib/creative-studio/composition-service'
import type { VideoEditContract } from '@/lib/creative-studio/video-edit-contract'
import type { StudioV3LifecycleClient } from '@/agent/components/creative-studio-v3/lifecycle-client'

export type StudioV3DataIssue = {
  resource: string
  message: string
}

export const STUDIO_V3_SCOPE_BOUNDARY = {
  accessibleBrands: 'Server-enforced accessible-brand list',
  projects: 'Server-derived route context is authoritative for collaborator projects',
  recipes: 'Server-enforced brand recipe filter where the endpoint admits the actor',
  gallery: 'Canonical project-asset and version lineage, filtered by server brand/project access',
  models: 'Server-filtered resource-scope registry; unscoped legacy identities are excluded',
  voices: 'Server-filtered resource-scope registry; unscoped legacy voices are excluded',
  ownedMedia: 'Server-filtered resource-scope registry; unscoped legacy media is excluded',
} as const

export type StudioV3HomeSnapshot = {
  brands: StudioBrandProfile[]
  projects: StudioProjectSummary[]
  recipes: StudioBrandRecipe[]
  models: SavedStudioModel[]
  recentAssets: GalleryItem[]
  config: StudioConfig | null
  health: StudioHealth | null
  retention: StudioRetentionDashboard | null
  issues: StudioV3DataIssue[]
}

export interface CreativeStudioV3ProductionPort
  extends CreativeStudioV3ReviewQueuePort, StudioV3LifecycleClient {
  loadHome(brandProfileId?: string | null, projectId?: string | null): Promise<StudioV3HomeSnapshot>
  listBrands(): Promise<StudioBrandProfile[]>
  listProjects(brandProfileId?: string | null): Promise<StudioProjectSummary[]>
  createProject(input: {
    name: string
    description?: string
    brandName?: string
    defaultFolder?: string
  }): Promise<StudioProjectSummary>
  listRecipes(brandProfileId?: string | null): Promise<StudioBrandRecipe[]>
  listProducts(query?: string): Promise<StudioProductOption[]>
  listCompositions(input: {
    brandProfileId: string
    projectId: string
  }): Promise<CreativeCompositionSummary[]>
  getReview(assetId: string, brandProfileId: string): Promise<StudioReviewThread>
  listModels(brandProfileId?: string | null, projectId?: string | null): Promise<SavedStudioModel[]>
  listGallery(query?: GalleryQuery, brandProfileId?: string | null, projectId?: string | null): Promise<GalleryPage>
  listVoices(brandProfileId?: string | null, projectId?: string | null): Promise<CreativeVoiceClient[]>
  listVideoUploads(brandProfileId?: string | null, projectId?: string | null): Promise<StudioVideoUpload[]>
  listMusicTracks(brandProfileId?: string | null, projectId?: string | null): Promise<StudioMusicTrack[]>
  getConfig(): Promise<StudioConfig>
  getSettings(): Promise<StudioSettings>
  getHealth(): Promise<StudioHealth>
  getAudioStatus(): Promise<AudioLabStatus>
  uploadImage(file: File, folder: string): Promise<string>
  uploadVideo(file: File, onProgress?: (percent: number) => void): Promise<StudioVideoUpload>
  estimateRun(
    payload: RunPayload & { auto?: boolean; includeFamily?: boolean; includeReel?: boolean },
    maxCostBdt?: number,
  ): Promise<StudioRunEstimateClient>
  confirmRun(
    payload: RunPayload & { auto?: boolean; includeFamily?: boolean; includeReel?: boolean },
    estimate: StudioRunEstimateClient,
    input: { maxCostBdt: number; idempotencyKey?: string },
  ): ReturnType<typeof import('@/agent/components/creative-studio/studio-api').confirmStudioJob>
  getVideoEditSource(pendingActionId: string, scope?: StudioAssetScope): Promise<VideoEditSource>
  finishImage(input: {
    storagePath: string
    hook: string
    productCode?: string
    productName?: string
    price?: string
    eyebrow?: string
    offer?: string
    mode?: 'model_overlay' | 'product_card' | 'lifestyle'
    theme?: string
    footer?: boolean
    fit?: 'cover' | 'contain'
    pendingActionId?: string
    brandProfileId?: string
    projectId?: string
    projectAssetId?: string
  }): Promise<{
    framedPath: string
    framedUrl: string
  }>
  uploadMask(
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
  }>
  finishVideo(pendingActionId: string, templates: VideoFinishTemplates, scope?: StudioAssetScope): Promise<{
    pendingActionId: string
    message: string
  }>
  partiallyFinishVideo(pendingActionId: string, editContract: VideoEditContract, scope?: StudioAssetScope): Promise<{
    pendingActionId: string
    message: string
  }>
}

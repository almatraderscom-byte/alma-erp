import type {
  AudioLabStatus,
  CreativeVoiceClient,
  GalleryItem,
  GalleryPage,
  GalleryQuery,
  RunPayload,
  SavedStudioModel,
  StudioBrandProfile,
  StudioConfig,
  StudioHealth,
  StudioMusicTrack,
  StudioRetentionDashboard,
  StudioSettings,
  StudioVideoUpload,
  VideoEditSource,
  VideoFinishTemplates,
  VideoRunOptions,
} from '@/agent/components/creative-studio/studio-api'
import type {
  StudioBrandRecipe,
  StudioProductOption,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'
import type { VideoEditContract } from '@/lib/creative-studio/video-edit-contract'

export type StudioV3DataIssue = {
  resource: string
  message: string
}

export const STUDIO_V3_SCOPE_BOUNDARY = {
  accessibleBrands: 'Server-enforced accessible-brand list',
  projects: 'Legacy owner-only endpoint; successful rows are presentation-filtered by canonical brandProfileId',
  recipes: 'Legacy owner-only endpoint; its brandProfileId filter is server-enforced for the owner',
  gallery: 'Legacy owner-only endpoint; no brand field/filter exists in the current contract',
  models: 'Legacy owner-only endpoint; no brand field/filter exists in the current contract',
  voices: 'Legacy owner-only endpoint; no brand field/filter exists in the current contract',
  ownedMedia: 'Legacy owner-only endpoint; no brand field/filter exists in the current contract',
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

export interface CreativeStudioV3ProductionPort {
  loadHome(brandProfileId?: string | null): Promise<StudioV3HomeSnapshot>
  listBrands(): Promise<StudioBrandProfile[]>
  listProjects(brandProfileId?: string | null): Promise<StudioProjectSummary[]>
  listRecipes(brandProfileId?: string | null): Promise<StudioBrandRecipe[]>
  listProducts(query?: string): Promise<StudioProductOption[]>
  listModels(brandProfileId?: string | null): Promise<SavedStudioModel[]>
  listGallery(query?: GalleryQuery, brandProfileId?: string | null): Promise<GalleryPage>
  listVoices(brandProfileId?: string | null): Promise<CreativeVoiceClient[]>
  listVideoUploads(brandProfileId?: string | null): Promise<StudioVideoUpload[]>
  listMusicTracks(brandProfileId?: string | null): Promise<StudioMusicTrack[]>
  getConfig(): Promise<StudioConfig>
  getSettings(): Promise<StudioSettings>
  getHealth(): Promise<StudioHealth>
  getAudioStatus(): Promise<AudioLabStatus>
  uploadImage(file: File, folder: string): Promise<string>
  uploadVideo(file: File, onProgress?: (percent: number) => void): Promise<StudioVideoUpload>
  queueAdvancedImage(payload: RunPayload): Promise<{
    jobs: Array<{ pendingActionId: string; label: string }>
    provider: string
    actualModel?: string
    message: string
  }>
  queueAutoImage(input: {
    productImagePath: string
    includeFamily?: boolean
    includeReel?: boolean
  }): Promise<{
    jobs: Array<{ pendingActionId: string; label: string }>
    provider: string
    message: string
  }>
  queueOwnedVideo(input: {
    videoPath: string
    videoName: string
    recipeId: string
    targets: number[]
    aspect: string
    options?: VideoRunOptions
  }): Promise<{
    jobs: Array<{ pendingActionId: string; label: string; targetSec: number }>
    message: string
  }>
  getVideoEditSource(pendingActionId: string): Promise<VideoEditSource>
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
  }): Promise<{
    framedPath: string
    framedUrl: string
  }>
  queueMaskedEdit(input: {
    sourceImagePath: string
    maskPath: string
    maskPreset: string
    prompt: string
    baseWidth: number
    baseHeight: number
  }): Promise<{
    jobs: Array<{ pendingActionId: string; label: string }>
    message: string
  }>
  uploadMask(maskBlob: Blob, basePath: string): Promise<{
    maskPath: string
    width: number
    height: number
    coveragePct: number
    estimatedCostUsd: number
  }>
  finishVideo(pendingActionId: string, templates: VideoFinishTemplates): Promise<{
    pendingActionId: string
    message: string
  }>
  partiallyFinishVideo(pendingActionId: string, editContract: VideoEditContract): Promise<{
    pendingActionId: string
    message: string
  }>
}

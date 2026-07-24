import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import type { EngineAvailability, StudioEngineId } from '@/lib/creative-studio/provider-registry'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import type { LifestyleLayoutOverrides } from '@/lib/content-engine/lifestyle-layout'
import type { GalleryMediaFilter, GalleryQcFilter, GalleryStateFilter } from '@/lib/creative-studio/gallery-query'
import type { StudioAssetState } from '@/lib/creative-studio/studio-policy'
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

export type StudioConfig = {
  fashnConfigured: boolean
  geminiConfigured: boolean
  veoConfigured: boolean
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
export async function finishImage(opts: FinishOptions): Promise<{ framedPath: string; framedUrl: string }> {
  return studioRequest<{ framedPath: string; framedUrl: string }>(
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
}

export async function fetchStudioConfig(): Promise<StudioConfig> {
  return studioRequest<StudioConfig>('/api/assistant/creative-studio/config', undefined, 'config_failed')
}

/**
 * iPhone photos are usually HEIC and often >10 MB — the upload route rejects
 * anything over its limit. Convert + downscale in the browser before upload:
 * iOS WKWebView decodes HEIC natively, so drawing to a canvas and exporting
 * JPEG fixes both the format and the size in one step (server still transcodes
 * as a backstop). PDFs / non-images pass through untouched; on any failure we
 * send the original and let the server handle it.
 */
async function prepareImageForUpload(file: File): Promise<File> {
  const looksImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)
  if (!looksImage || typeof document === 'undefined') return file
  try {
    const bitmap = await createImageBitmap(file)
    const MAX = 2048
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9))
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
  return studioRequest<{
    maskPath: string
    width: number
    height: number
    coveragePct: number
    estimatedCostUsd: number
  }>('/api/assistant/creative-studio/mask-upload', { method: 'POST', body: fd }, 'mask_upload_failed')
}

export async function runStudioJob(payload: RunPayload) {
  return studioRequest<{
    jobs: Array<{ pendingActionId: string; label: string }>
    provider: string
    message: string
  }>(
    '/api/assistant/creative-studio/run',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'run_failed',
  )
}

export async function runAutoStudioJob(input: { productImagePath: string; includeFamily?: boolean; includeReel?: boolean }) {
  return studioRequest<{
    jobs: Array<{ pendingActionId: string; label: string }>
    provider: string
    message: string
  }>(
    '/api/assistant/creative-studio/run',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: true, ...input }),
    },
    'run_failed',
  )
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

export async function fetchModels() {
  return studioRequest<{ models: SavedStudioModel[] }>('/api/assistant/brand-models', undefined, 'models_failed')
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
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_default', id }),
    },
    'set_default_failed',
  )
}

/** Remove a saved model from the library. */
export async function deleteModel(id: string) {
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', id }),
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

export async function fetchStudioVideos(): Promise<StudioVideoUpload[]> {
  const data = await studioRequest<{ uploads?: StudioVideoUpload[] }>('/api/assistant/creative-studio/video', undefined, 'videos_failed')
  return (data.uploads ?? []) as StudioVideoUpload[]
}

/**
 * Big phone shoots (up to ~500 MB) go STRAIGHT to Supabase storage with a
 * signed upload URL — Vercel never sees the body. XHR (not fetch) so the owner
 * gets a real progress bar on a multi-minute upload.
 */
export async function uploadStudioVideo(file: File, onProgress?: (pct: number) => void): Promise<StudioVideoUpload> {
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
      }),
    },
    'register_failed',
  )
  return regData.upload as StudioVideoUpload
}

export async function deleteStudioVideo(id: string): Promise<void> {
  await studioRequest<unknown>(`/api/assistant/creative-studio/video?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'delete_failed')
}

export type StudioMusicTrack = {
  id: string
  path: string
  name: string
  vibe: string
  sizeBytes: number
  uploadedAt: string
}

export async function fetchMusicTracks(): Promise<StudioMusicTrack[]> {
  const data = await studioRequest<{ tracks?: StudioMusicTrack[] }>('/api/assistant/creative-studio/music', undefined, 'music_failed')
  return (data.tracks ?? []) as StudioMusicTrack[]
}

/** Owner-approved music beds only — uploaded from his own files, signed direct upload. */
export async function uploadMusicTrack(file: File, vibe: string, onProgress?: (pct: number) => void): Promise<StudioMusicTrack> {
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
      }),
    },
    'register_failed',
  )
  return regData.track as StudioMusicTrack
}

export async function deleteMusicTrack(id: string): Promise<void> {
  await studioRequest<unknown>(`/api/assistant/creative-studio/music?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'delete_failed')
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
): Promise<{ pendingActionId: string; message: string }> {
  return studioRequest<{ pendingActionId: string; message: string }>(
    '/api/assistant/creative-studio/video/finish',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingActionId, templates }),
    },
    'finish_failed',
  )
}

// ── E1 Audio Lab helpers ─────────────────────────────────────────────────────

export type AudioLabStatus = {
  voiceCloned: boolean
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
  costBdt: number
  maxCostBdt: number
}

export async function estimateAudioJob(body: Record<string, unknown>): Promise<AudioJobEstimate> {
  return studioRequest<AudioJobEstimate>(
    '/api/assistant/creative-studio/audio',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, intent: 'estimate' }),
    },
    'audio_estimate_failed',
  )
}

export async function queueAudioJob(body: Record<string, unknown>, confirmation: { confirmedCostBdt: number; costCapBdt: number }) {
  return studioRequest<{
    pendingActionId: string
    costBdt: number
    maxCostBdt: number
  }>(
    '/api/assistant/creative-studio/audio',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, intent: 'queue', ...confirmation }),
    },
    'audio_failed',
  )
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
  return studioRequest<{ pendingActionId: string }>(
    `/api/assistant/creative-studio/jobs/${pendingActionId}/retry`,
    { method: 'POST' },
    'retry_failed',
  )
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
  return studioRequest<{
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
}

export async function fetchVideoJob(id: string): Promise<VideoJobStatus> {
  return studioRequest<VideoJobStatus>(`/api/assistant/creative-studio/jobs/${id}`, undefined, 'job_failed')
}

export async function saveModel(body: { id: string; name: string; imagePath: string; role: string; notes?: string }) {
  return studioRequest<unknown>(
    '/api/assistant/brand-models',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', ...body }),
    },
    'save_failed',
  )
}

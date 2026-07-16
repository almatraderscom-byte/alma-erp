import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import type { EngineAvailability, StudioEngineId } from '@/lib/creative-studio/provider-registry'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import type { LifestyleLayoutOverrides } from '@/lib/content-engine/lifestyle-layout'

export type StudioConfig = {
  fashnConfigured: boolean
  geminiConfigured: boolean
  veoConfigured: boolean
  /** CS5 — FAL_KEY present on the server (foundation; engines runnable from CS6/CS7) */
  falConfigured: boolean
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
  qc?: { pass?: boolean; overall?: number; attempts?: number; flagged?: string } | null
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
  const res = await fetch('/api/assistant/creative-studio/branding')
  if (!res.ok) throw new Error('brand_status_failed')
  return res.json()
}

/** Upload / replace the ALMA logo (auto-resized server-side). Stored in BrandAsset. */
export async function saveBrandLogo(logo: File, transparent = true): Promise<BrandStatus> {
  const fd = new FormData()
  fd.append('logo', logo)
  fd.append('transparent', transparent ? '1' : '0')
  const res = await fetch('/api/assistant/creative-studio/branding', { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'logo_save_failed')
  return data as BrandStatus
}

/** Apply the deterministic brand frame (logo + this image's code + hook). */
export async function finishImage(opts: FinishOptions): Promise<{ framedPath: string; framedUrl: string }> {
  const res = await fetch('/api/assistant/creative-studio/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'finish_failed')
  return data as { framedPath: string; framedUrl: string }
}

export type RunPayload = {
  mode: StudioModeId
  provider?: StudioProvider
  /** CS6 — single Try-On engine choice (fashn / gemini / fal_fashn_v16 / fal_idm_vton) */
  vtonEngine?: StudioEngineId
  /** CS6 — owner override for garment placement when auto classification is uncertain */
  clothType?: 'auto' | 'overall' | 'upper' | 'lower' | 'outer'
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
}

export async function fetchStudioConfig(): Promise<StudioConfig> {
  const res = await fetch('/api/assistant/creative-studio/config')
  if (!res.ok) throw new Error('config_failed')
  return res.json()
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
  const looksImage =
    file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)
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
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    )
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
  const res = await fetch('/api/assistant/creative-studio/drive-status')
  if (!res.ok) throw new Error('drive_status_failed')
  return res.json()
}

export async function disconnectDrive(): Promise<void> {
  const res = await fetch('/api/assistant/creative-studio/drive-status', { method: 'DELETE' })
  if (!res.ok) throw new Error('drive_disconnect_failed')
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
  const res = await fetch('/api/assistant/upload', { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'upload_failed')
  return data.path as string
}

/** CS7 — upload a painted FLUX Fill mask; server validates dims vs base + coverage. */
export async function uploadFillMask(maskBlob: Blob, basePath: string): Promise<{
  maskPath: string
  width: number
  height: number
  coveragePct: number
  estimatedCostUsd: number
}> {
  const fd = new FormData()
  fd.append('mask', new File([maskBlob], 'mask.png', { type: 'image/png' }))
  fd.append('basePath', basePath)
  const res = await fetch('/api/assistant/creative-studio/mask-upload', { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'mask_upload_failed')
  return data
}

export async function runStudioJob(payload: RunPayload) {
  const res = await fetch('/api/assistant/creative-studio/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? data.message ?? 'run_failed')
  return data as { jobs: Array<{ pendingActionId: string; label: string }>; provider: string; message: string }
}

export async function runAutoStudioJob(input: { productImagePath: string; includeFamily?: boolean; includeReel?: boolean }) {
  const res = await fetch('/api/assistant/creative-studio/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto: true, ...input }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? data.message ?? 'run_failed')
  return data as { jobs: Array<{ pendingActionId: string; label: string }>; provider: string; message: string }
}

export async function fetchGallery(page = 1): Promise<{ items: GalleryItem[]; hasMore: boolean; total: number }> {
  const res = await fetch(`/api/assistant/creative-studio/gallery?page=${page}&limit=24`)
  if (!res.ok) throw new Error('gallery_failed')
  return res.json()
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
}

export async function fetchModels() {
  const res = await fetch('/api/assistant/brand-models')
  if (!res.ok) throw new Error('models_failed')
  return res.json() as Promise<{ models: SavedStudioModel[] }>
}

/** Make one saved model the default the Auto tab uses (per-image select stays manual). */
export async function setDefaultModel(id: string) {
  const res = await fetch('/api/assistant/brand-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set_default', id }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'set_default_failed')
  return data
}

/** Remove a saved model from the library. */
export async function deleteModel(id: string) {
  const res = await fetch('/api/assistant/brand-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'delete_failed')
  return data
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
  const res = await fetch('/api/assistant/creative-studio/video')
  if (!res.ok) throw new Error('videos_failed')
  const data = await res.json()
  return (data.uploads ?? []) as StudioVideoUpload[]
}

/**
 * Big phone shoots (up to ~500 MB) go STRAIGHT to Supabase storage with a
 * signed upload URL — Vercel never sees the body. XHR (not fetch) so the owner
 * gets a real progress bar on a multi-minute upload.
 */
export async function uploadStudioVideo(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<StudioVideoUpload> {
  const urlRes = await fetch('/api/assistant/creative-studio/video/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
  })
  const urlData = await urlRes.json().catch(() => ({}))
  if (!urlRes.ok) throw new Error(urlData.error ?? 'upload_url_failed')

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', urlData.uploadUrl)
    xhr.setRequestHeader('Content-Type', urlData.contentType ?? file.type ?? 'video/mp4')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`upload_failed_${xhr.status}`))
    xhr.onerror = () => reject(new Error('upload_network_error'))
    xhr.send(file)
  })

  const regRes = await fetch('/api/assistant/creative-studio/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: urlData.uploadId, path: urlData.path, name: file.name, sizeBytes: file.size }),
  })
  const regData = await regRes.json().catch(() => ({}))
  if (!regRes.ok) throw new Error(regData.error ?? 'register_failed')
  return regData.upload as StudioVideoUpload
}

export async function deleteStudioVideo(id: string): Promise<void> {
  const res = await fetch(`/api/assistant/creative-studio/video?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error('delete_failed')
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
  const res = await fetch('/api/assistant/creative-studio/music')
  if (!res.ok) throw new Error('music_failed')
  const data = await res.json()
  return (data.tracks ?? []) as StudioMusicTrack[]
}

/** Owner-approved music beds only — uploaded from his own files, signed direct upload. */
export async function uploadMusicTrack(
  file: File,
  vibe: string,
  onProgress?: (pct: number) => void,
): Promise<StudioMusicTrack> {
  const urlRes = await fetch('/api/assistant/creative-studio/music/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
  })
  const urlData = await urlRes.json().catch(() => ({}))
  if (!urlRes.ok) throw new Error(urlData.error ?? 'upload_url_failed')

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', urlData.uploadUrl)
    xhr.setRequestHeader('Content-Type', urlData.contentType ?? file.type ?? 'audio/mpeg')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload_failed_${xhr.status}`))
    xhr.onerror = () => reject(new Error('upload_network_error'))
    xhr.send(file)
  })

  const regRes = await fetch('/api/assistant/creative-studio/music', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: urlData.uploadId, path: urlData.path, name: file.name, vibe, sizeBytes: file.size }),
  })
  const regData = await regRes.json().catch(() => ({}))
  if (!regRes.ok) throw new Error(regData.error ?? 'register_failed')
  return regData.track as StudioMusicTrack
}

export async function deleteMusicTrack(id: string): Promise<void> {
  const res = await fetch(`/api/assistant/creative-studio/music?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('delete_failed')
}

/** Set a reel's cover from the worker's candidate frames. */
export async function setReelCover(pendingActionId: string, coverPath: string): Promise<{ thumbUrl: string | null }> {
  const res = await fetch('/api/assistant/creative-studio/video/cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingActionId, coverPath }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'cover_failed')
  return data as { thumbUrl: string | null }
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
  const res = await fetch('/api/assistant/creative-studio/video/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingActionId, templates }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'finish_failed')
  return data
}

// ── E1 Audio Lab helpers ─────────────────────────────────────────────────────

export type AudioLabStatus = {
  voiceCloned: boolean
  styles: Array<{ id: string; labelBn: string }>
  occasions: Array<{ id: string; labelBn: string }>
}

export async function fetchAudioLabStatus(): Promise<AudioLabStatus> {
  const res = await fetch('/api/assistant/creative-studio/audio')
  if (!res.ok) throw new Error('audio_status_failed')
  return res.json()
}

export async function queueAudioJob(body: Record<string, unknown>) {
  const res = await fetch('/api/assistant/creative-studio/audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'audio_failed')
  return data as { pendingActionId: string; costBdt: number }
}

export async function uploadAudioFile(file: File, onProgress?: (pct: number) => void): Promise<string> {
  const urlRes = await fetch('/api/assistant/creative-studio/audio/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
  })
  const urlData = await urlRes.json().catch(() => ({}))
  if (!urlRes.ok) throw new Error(urlData.error ?? 'upload_url_failed')
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
  const res = await fetch('/api/assistant/creative-studio/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingActionId, verdict }),
  })
  if (!res.ok) throw new Error('feedback_failed')
  return res.json() as Promise<{ weighted: boolean; weight?: number }>
}

export async function retryStudioJob(pendingActionId: string) {
  const res = await fetch(`/api/assistant/creative-studio/jobs/${pendingActionId}/retry`, { method: 'POST' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'retry_failed')
  return data as { pendingActionId: string }
}

export type StudioSettings = {
  qcLevel: 'off' | 'normal' | 'strict'
  notifyOnDone: boolean
  /** Which model family renders images: Nano Banana (default) or GPT Image 2. */
  imageEngine: 'gemini' | 'gpt' | 'seedream'
  sceneWeights: Record<string, number>
  childGarments: Array<{ key: string; role: string; productPath: string; garmentPath: string; url: string | null }>
  /** CS5 — Fal foundation flags (default OFF; engines runnable from CS6/CS7) */
  falEnabled: boolean
  idmVtonEnabled: boolean
  fluxFillEnabled: boolean
  singleVtonDefault: StudioEngineId
}

export async function fetchStudioSettings(): Promise<StudioSettings> {
  const res = await fetch('/api/assistant/creative-studio/settings')
  if (!res.ok) throw new Error('settings_failed')
  return res.json()
}

export async function saveStudioSettings(patch: {
  qcLevel?: string
  notifyOnDone?: boolean
  imageEngine?: 'gemini' | 'gpt' | 'seedream'
  falEnabled?: boolean
  idmVtonEnabled?: boolean
  fluxFillEnabled?: boolean
  singleVtonDefault?: StudioEngineId
}) {
  const res = await fetch('/api/assistant/creative-studio/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error('settings_save_failed')
}

export async function deleteGarmentCache(key: string) {
  const res = await fetch(`/api/assistant/creative-studio/settings?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('cache_delete_failed')
}

export async function generateBrandModel(role: string) {
  const res = await fetch('/api/assistant/creative-studio/model-creator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'model_gen_failed')
  return data as { pendingActionId: string }
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
}): Promise<{ jobs: Array<{ pendingActionId: string; label: string; targetSec: number }>; message: string }> {
  const res = await fetch('/api/assistant/creative-studio/video/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'run_failed')
  return data
}

export async function fetchVideoJob(id: string): Promise<VideoJobStatus> {
  const res = await fetch(`/api/assistant/creative-studio/jobs/${id}`)
  if (!res.ok) throw new Error('job_failed')
  return res.json() as Promise<VideoJobStatus>
}

export async function saveModel(body: {
  id: string
  name: string
  imagePath: string
  role: string
  notes?: string
}) {
  const res = await fetch('/api/assistant/brand-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'save_failed')
  return data
}

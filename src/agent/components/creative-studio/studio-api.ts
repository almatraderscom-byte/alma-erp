import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'

export type StudioConfig = {
  fashnConfigured: boolean
  geminiConfigured: boolean
  veoConfigured: boolean
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
  previewUrl: string | null
  /** small webp for the grid tile (falls back to previewUrl) */
  thumbUrl?: string | null
  /** branded variant (logo + code + hook), when produced */
  brandedUrl?: string | null
  storagePath: string | null
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

export type FinishMode = 'model_overlay' | 'product_card'

export type FinishOptions = {
  storagePath: string
  hook: string
  productCode?: string
  productName?: string
  price?: string
  mode?: FinishMode
  theme?: string
  footer?: boolean
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
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
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
  const fd = new FormData()
  fd.append('file', file)
  fd.append('conversationId', folder)
  const res = await fetch('/api/assistant/upload', { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'upload_failed')
  return data.path as string
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

export async function fetchModels() {
  const res = await fetch('/api/assistant/brand-models')
  if (!res.ok) throw new Error('models_failed')
  return res.json() as Promise<{ models: Array<{ id: string; name: string; role: string | null; isDefault: boolean }> }>
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

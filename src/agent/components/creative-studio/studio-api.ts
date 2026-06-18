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
  storagePath: string | null
  error: string | null
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

export async function runAutoStudioJob(input: { productImagePath: string; includeFamily?: boolean }) {
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
  if (!res.ok) throw new Error(data.error ?? 'save_failed')
  return data
}

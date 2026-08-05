import type {
  CreativeVoiceClient,
  GalleryItem,
  SavedStudioModel,
} from '@/agent/components/creative-studio/studio-api'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import type { CreativeStudioV3LibraryType } from '@/agent/components/creative-studio-v3/types'

export type StudioV3Lifecycle = 'recent' | 'approved' | 'review' | 'archived'
export type StudioV3GalleryDensity = 'large' | 'comfortable' | 'compact' | 'list'
export type StudioV3LibrarySource = 'gallery' | 'voice' | 'avatar' | 'project'

export type StudioV3LibraryItem = {
  id: string
  source: StudioV3LibrarySource
  type: Exclude<CreativeStudioV3LibraryType, 'all'>
  title: string
  subtitle: string
  previewUrl: string | null
  createdAt: string | null
  lifecycle: StudioV3Lifecycle
  status: string
  provider: string | null
  aspect: string | null
  dimensions: string | null
  costUsd: number | null
  storagePath: string | null
  publishable: boolean
  galleryItem: GalleryItem | null
}
function galleryType(item: GalleryItem): 'image' | 'video' | 'audio' {
  if (item.type.includes('video')) return 'video'
  if (item.type.includes('audio')) return 'audio'
  return 'image'
}

function galleryLifecycle(item: GalleryItem): StudioV3Lifecycle {
  if (item.status === 'archived' || item.assetState === ('archived' as typeof item.assetState)) return 'archived'
  if (item.publishable && item.assetState === 'ready') return 'approved'
  if (item.assetState === 'qc_failed' || item.assetState === 'draft' || item.status === 'failed') return 'review'
  return 'recent'
}

export function libraryItemFromGallery(item: GalleryItem): StudioV3LibraryItem {
  const original = item.originalVariant ?? item.variants?.find((variant) => variant.kind === 'original') ?? null
  const resolution = item.resolutionIntegrity as { requestedTier?: unknown; requestedAspectRatio?: unknown } | null
  return {
    id: item.id,
    source: 'gallery',
    type: galleryType(item),
    title: item.summary ?? item.mode ?? 'Untitled production asset',
    subtitle: [item.mode, item.engine ?? item.provider].filter(Boolean).join(' · '),
    previewUrl: item.thumbUrl ?? item.previewUrl,
    createdAt: item.createdAt,
    lifecycle: galleryLifecycle(item),
    status: item.assetState,
    provider: item.imageModel ?? item.engine ?? item.provider ?? null,
    aspect: typeof resolution?.requestedAspectRatio === 'string' ? resolution.requestedAspectRatio : null,
    dimensions: original?.width && original?.height ? `${original.width}×${original.height}` : null,
    costUsd: item.costUsd ?? null,
    storagePath: original?.storagePath ?? item.storagePath,
    publishable: item.publishable,
    galleryItem: item,
  }
}

export function libraryItemFromVoice(voice: CreativeVoiceClient): StudioV3LibraryItem {
  const latest = voice.versions[0] ?? null
  const active = voice.versions.find((version) => version.id === voice.activeVersionId) ?? null
  const archived = latest?.status === 'deleted'
  return {
    id: voice.id,
    source: 'voice',
    type: 'voice',
    title: voice.name,
    subtitle: `${voice.provider} · owner-only · ${voice.versions.length} version${voice.versions.length === 1 ? '' : 's'}`,
    previewUrl: null,
    createdAt: latest?.createdAt ?? null,
    lifecycle: archived ? 'archived' : active ? 'approved' : 'review',
    status: active ? `active v${active.version}` : latest?.status ?? 'no version',
    provider: voice.provider,
    aspect: null,
    dimensions: null,
    costUsd: null,
    storagePath: null,
    publishable: false,
    galleryItem: null,
  }
}

export function libraryItemFromModel(model: SavedStudioModel): StudioV3LibraryItem {
  return {
    id: model.id,
    source: 'avatar',
    type: 'avatar',
    title: model.name,
    subtitle: `${model.role ?? 'Unassigned role'} · ${model.avatar?.built ? `${model.avatar.count} angle identity` : 'single reference'}`,
    previewUrl: model.imageUrl ?? null,
    createdAt: null,
    lifecycle: model.avatar?.built ? 'approved' : 'review',
    status: model.avatar?.building ? 'building' : model.avatar?.built ? 'canonical' : 'reference only',
    provider: null,
    aspect: null,
    dimensions: null,
    costUsd: null,
    storagePath: model.imagePath ?? null,
    publishable: false,
    galleryItem: null,
  }
}

export function libraryItemFromProject(project: StudioProjectSummary): StudioV3LibraryItem {
  return {
    id: project.id,
    source: 'project',
    type: 'project',
    title: project.name,
    subtitle: `${project.product?.code ?? 'No ERP product'} · ${project.assetCount} assets · ${project.defaultFolder}`,
    previewUrl: project.product?.previewImage ?? project.product?.sourceImage ?? null,
    createdAt: project.updatedAt,
    lifecycle: 'recent',
    status: project.readonly ? 'legacy read-only' : project.currentRecipe?.locked ? 'recipe locked' : 'active',
    provider: null,
    aspect: null,
    dimensions: null,
    costUsd: null,
    storagePath: null,
    publishable: false,
    galleryItem: null,
  }
}

export function sortStudioV3Library(
  items: StudioV3LibraryItem[],
  sort: 'newest' | 'oldest' | 'name' | 'cost',
): StudioV3LibraryItem[] {
  return [...items].sort((left, right) => {
    if (sort === 'name') return left.title.localeCompare(right.title, 'en')
    if (sort === 'cost') return (right.costUsd ?? -1) - (left.costUsd ?? -1)
    const a = left.createdAt ? new Date(left.createdAt).getTime() : 0
    const b = right.createdAt ? new Date(right.createdAt).getTime() : 0
    return sort === 'oldest' ? a - b : b - a
  })
}

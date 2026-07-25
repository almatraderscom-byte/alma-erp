import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import type {
  StudioV3GalleryDensity,
  StudioV3Lifecycle,
} from '@/agent/components/creative-studio-v3/gallery-model'
import type {
  CreativeStudioV3DeskId,
  CreativeStudioV3LibraryType,
} from '@/agent/components/creative-studio-v3/types'

export const STUDIO_V3_GALLERY_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'voice', label: 'Voice' },
  { id: 'avatar', label: 'Avatar' },
  { id: 'project', label: 'Project' },
] as const satisfies ReadonlyArray<{ id: CreativeStudioV3LibraryType; label: string }>

export const STUDIO_V3_LIFECYCLES = [
  { id: 'recent', label: 'Recent' },
  { id: 'approved', label: 'Approved' },
  { id: 'review', label: 'Needs review' },
  { id: 'archived', label: 'Archived' },
] as const satisfies ReadonlyArray<{ id: StudioV3Lifecycle; label: string }>

export const STUDIO_V3_GALLERY_DENSITIES = [
  { id: 'large', label: 'Large' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
  { id: 'list', label: 'List' },
] as const satisfies ReadonlyArray<{ id: StudioV3GalleryDensity; label: string }>

export const STUDIO_V3_CAPABILITY_DESKS = [
  'projects',
  'systems',
  'review',
  'operations',
  'voice',
  'audio',
  'campaign',
] as const satisfies ReadonlyArray<CreativeStudioV3DeskId>

/**
 * Remembered/query IDs are preferences only. Selection is always resolved
 * against the latest server-returned accessible brand rows.
 */
export function selectAccessibleStudioBrand(
  brands: StudioBrandProfile[],
  requestedId: string | null | undefined,
  rememberedId: string | null | undefined,
): StudioBrandProfile | null {
  const candidateId = requestedId ?? rememberedId
  return brands.find((brand) => brand.brandProfileId === candidateId) ?? brands[0] ?? null
}

/**
 * The current projects endpoint is owner-only and includes a canonical
 * brandProfileId per non-legacy project. This is a presentation filter only;
 * authorization remains on the server.
 */
export function scopeProjectsToBrand(
  projects: StudioProjectSummary[],
  brandProfileId?: string | null,
): StudioProjectSummary[] {
  if (!brandProfileId) return projects
  return projects.filter((project) => project.brandProfileId === brandProfileId)
}

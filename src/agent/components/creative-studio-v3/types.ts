import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'
import type { StudioProjectSummary } from '@/lib/creative-studio/project-contract'
import type { StudioAccessRole } from '@/lib/creative-studio/studio-access'

export type CreativeStudioV3DeskId =
  | 'projects'
  | 'systems'
  | 'review'
  | 'operations'
  | 'voice'
  | 'audio'
  | 'campaign'

export type CreativeStudioV3LibraryType =
  | 'all'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'avatar'
  | 'project'

export type CreativeStudioV3ReviewTarget = {
  brandProfileId: string
  projectId: string
  projectAssetId: string
  currentVersionId: string
  expectedSequence: number
}

export type CreativeStudioV3View =
  | { id: 'home' }
  | { id: 'image-lab'; sourceAssetId?: string; avatarId?: string }
  | { id: 'video-lab'; sourceAssetId?: string; avatarId?: string }
  | {
      id: 'gallery'
      initialType?: CreativeStudioV3LibraryType
      reviewTarget?: CreativeStudioV3ReviewTarget
    }
  | { id: 'finishing'; assetId?: string }
  | { id: 'desk'; desk: CreativeStudioV3DeskId; projectId?: string }
  | {
      id: 'editor'
      accessRole: StudioAccessRole
      brandProfileId: string
      brandName: string
      compositionId: string
      projectId: string
      returnTo: 'home' | 'projects'
    }

export type CreativeStudioV3Navigate = (view: CreativeStudioV3View) => void

export type CreativeStudioV3InitialContext = {
  brandId: string | null
  projectId: string | null
  actorUserId: string
  accountLabel: string
  studioRole: StudioAccessRole
  accessibleProjects: StudioProjectSummary[]
  foundation: {
    readEnabled: boolean
    writesEnabled: boolean
  }
  legacyAllowed: boolean
}

export type CreativeStudioV3BrandContext = {
  activeBrand: StudioBrandProfile | null
  activeBrandId: string | null
  setActiveBrandId: (brandId: string) => void
}

export type CreativeStudioV3ReviewQueueItem = {
  projectAssetId: string
  projectId: string
  brandProfileId: string
  currentVersionId: string
  expectedSequence: number
  state: 'draft' | 'changes_requested' | 'revised' | 'approved'
  title: string | null
  previewUrl: string | null
}

/**
 * Access-scoped canonical CSE6 queue boundary. IDs, sequence and version come
 * from the server; the UI never derives review authority from Gallery jobs.
 */
export interface CreativeStudioV3ReviewQueuePort {
  listReviewQueue(input: {
    brandProfileId: string
    projectId?: string | null
  }): Promise<{
    items: CreativeStudioV3ReviewQueueItem[]
    nextCursor: string | null
  }>
}

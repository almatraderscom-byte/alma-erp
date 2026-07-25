import type { StudioBrandProfile } from '@/agent/components/creative-studio/studio-api'

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

export type CreativeStudioV3View =
  | { id: 'home' }
  | { id: 'image-lab'; sourceAssetId?: string; avatarId?: string }
  | { id: 'video-lab'; sourceAssetId?: string; avatarId?: string }
  | { id: 'gallery'; initialType?: CreativeStudioV3LibraryType }
  | { id: 'finishing'; assetId?: string }
  | { id: 'desk'; desk: CreativeStudioV3DeskId }

export type CreativeStudioV3Navigate = (view: CreativeStudioV3View) => void

export type CreativeStudioV3InitialContext = {
  brandId: string | null
  projectId: string | null
  accountLabel: string
  studioRoleLabel: string
  legacyAllowed: boolean
}

export type CreativeStudioV3BrandContext = {
  activeBrand: StudioBrandProfile | null
  activeBrandId: string | null
  setActiveBrandId: (brandId: string) => void
}

/**
 * UI-only boundary for the composition command foundation. Workstream U does
 * not implement this server authority. The integration stream supplies an
 * adapter after its exact SHA is approved.
 */
export interface CreativeStudioV3FoundationPort {
  openComposition(input: {
    projectId: string
    brandProfileId: string
  }): Promise<{
    compositionId: string
    version: number
    concurrencyToken: string
  }>
  planOperations(input: {
    compositionId: string
    expectedVersion: number
    instruction: string
  }): Promise<{
    planId: string
    fingerprint: string
    effectClass: 'local' | 'paid' | 'external'
    estimatedCostBdt: number
  }>
  applyLocalOperations(input: {
    compositionId: string
    expectedVersion: number
    planId: string
    fingerprint: string
  }): Promise<{
    version: number
    auditId: string
  }>
  rollback(input: {
    compositionId: string
    expectedVersion: number
    targetVersion: number
  }): Promise<{
    version: number
    auditId: string
  }>
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
 * Missing list boundary for CSE6. The existing review endpoint can open an
 * exact project asset, but no access-scoped queue currently returns the
 * canonical IDs required to do that safely. The UI must not derive these IDs
 * from legacy Gallery jobs.
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

import type { CreateKind, StudioProject } from './studio-v2-fixtures'
import type { CapabilityDeskId, GalleryAssetType } from './studio-v3-fixtures'

export type StudioV3View =
  | { id: 'home' }
  | { id: 'image-lab'; sourceAssetId?: string; avatarId?: string }
  | { id: 'video-lab'; sourceAssetId?: string; avatarId?: string }
  | { id: 'gallery'; initialType?: GalleryAssetType | 'all' }
  | { id: 'finishing'; assetId?: string }
  | { id: 'desk'; desk: CapabilityDeskId }
  | { id: 'project-setup'; kind: 'video' | 'longform' }
  | {
      id: 'editor'
      kind: CreateKind
      project?: StudioProject
      projectName?: string
      emptyProject?: boolean
      canvasPreset?: '9:16' | '1:1' | '4:5' | '16:9'
      openAgent?: boolean
    }

export type StudioV3Navigate = (view: StudioV3View) => void

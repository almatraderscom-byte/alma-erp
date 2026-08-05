import type { CreateKind, StudioProject } from './studio-v2-fixtures'
import type { CapabilityDeskId, GalleryAssetType } from './studio-v3-fixtures'
import type {
  StudioConfig,
  StudioHealth,
} from '../creative-studio/studio-api'

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

export type StudioDemoApiState = {
  phase: 'checking' | 'connected' | 'degraded'
  config: StudioConfig | null
  health: StudioHealth | null
  error: string | null
  lastCheckedAt: string | null
}

export const INITIAL_STUDIO_DEMO_API_STATE: StudioDemoApiState = {
  phase: 'checking',
  config: null,
  health: null,
  error: null,
  lastCheckedAt: null,
}

const DEMO_PROVIDER_ENGINE_IDS = {
  grok: 'xai_imagine',
  'fashn-direct': 'fashn',
  'fal-fashn': 'fal_fashn_v16',
  'gemini-draft': 'gemini',
  'idm-vton': 'fal_idm_vton',
  'flux-fill': 'fal_flux_fill',
  'veo-preview': 'gemini',
} as const

export type StudioDemoProviderAvailability =
  | 'checking'
  | 'available'
  | 'unavailable'
  | 'local'
  | 'unknown'

export function studioDemoProviderAvailability(
  state: StudioDemoApiState,
  providerId: string,
): StudioDemoProviderAvailability {
  if (providerId === 'owned-local') return 'local'
  if (state.phase === 'checking') return 'checking'

  const engineId =
    DEMO_PROVIDER_ENGINE_IDS[providerId as keyof typeof DEMO_PROVIDER_ENGINE_IDS]
  if (!engineId || !state.config) return 'unknown'

  const engine = state.config.engines.find((item) => item.id === engineId)
  return engine?.configured && engine.enabled && engine.runnable && !engine.killed
    ? 'available'
    : 'unavailable'
}

export function studioDemoLiveEngineCount(state: StudioDemoApiState): number {
  return (
    state.config?.engines.filter(
      (engine) =>
        engine.configured &&
        engine.enabled &&
        engine.runnable &&
        !engine.killed,
    ).length ?? 0
  )
}

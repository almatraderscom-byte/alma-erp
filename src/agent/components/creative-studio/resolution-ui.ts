import type {
  FamilyPresetId,
  StudioModeId,
  StudioProvider,
} from '@/lib/creative-studio/constants'
import type { StudioEngineId } from '@/lib/creative-studio/provider-registry'
import {
  getResolutionContract,
  resolutionOptionLabel,
  supportedTiersForAspect,
  type StudioAspectRatio,
  type StudioImageEngine,
} from '@/lib/creative-studio/resolution-contract'
import type { FashnResolution } from '@/lib/fashn/types'

export type StudioFinalImageEngine = StudioImageEngine | 'family_composite' | null

export type StudioResolutionContext = {
  mode: StudioModeId
  provider: StudioProvider | 'xai_imagine'
  vtonEngine: StudioEngineId
  familyPreset: FamilyPresetId
  protectedComposite: boolean
  imageEngine: 'gemini' | 'gpt' | 'seedream'
  /** Authoritative branch decision from StudioWorkspaceView (handles full-family merge). */
  xaiWillRun?: boolean
}

export type StudioResolutionUiState = {
  kind: 'tiered' | 'fixed' | 'source' | 'video' | 'unsupported'
  engine: StudioFinalImageEngine
  contractEngine: StudioImageEngine | null
  labelBn: string
  detailBn: string
  supportedAspects: StudioAspectRatio[]
  supportedTiers: FashnResolution[]
  aspectRatio: StudioAspectRatio | null
  resolution: FashnResolution | null
  resolutionOptions: Array<{ value: FashnResolution; label: string }>
}

/** Resolve the B resolution contract from A's immutable generic model choice. */
export function resolutionEngineForGenericModel(
  model: string | null | undefined,
  fallback: StudioResolutionContext['imageEngine'] = 'gemini',
): StudioResolutionContext['imageEngine'] {
  if (!model) return fallback
  if (model.startsWith('gpt-image')) return 'gpt'
  if (model.startsWith('seedream')) return 'seedream'
  return 'gemini'
}

/**
 * Resolve the engine that creates the final gallery image, rather than merely
 * the first engine in a multi-step Try-On/family chain.
 */
export function resolveFinalStudioImageEngine(
  context: StudioResolutionContext,
): StudioFinalImageEngine {
  if (context.mode === 'image_to_video') return null

  const isVtonMode = context.mode === 'product_to_model' || context.mode === 'try_on'
  const isMultiPersonFamily = isVtonMode && context.familyPreset !== 'single'
  const xaiWillRun = context.xaiWillRun ?? (
    context.mode === 'generate'
    || (isVtonMode
      ? context.vtonEngine === 'xai_imagine'
      : context.provider === 'xai_imagine')
  )

  if (xaiWillRun) return 'xai_imagine'

  if (isMultiPersonFamily) {
    return context.protectedComposite ? 'family_composite' : context.imageEngine
  }

  if (context.mode === 'try_on') {
    if (context.vtonEngine === 'fal_fashn_v16' || context.vtonEngine === 'fal_idm_vton') {
      return context.vtonEngine
    }
    // Direct FASHN Try-On is followed by the configured generic rescene stage.
    return context.imageEngine
  }

  if (context.mode === 'product_to_model') {
    // Unsupported Fal VTON selections are reset by the UI and rejected again
    // server-side; this fallback only describes the supported direct-FASHN and
    // configured generic lanes.
    return context.vtonEngine === 'gemini' ? context.imageEngine : 'fashn'
  }

  if (context.provider === 'gemini') return context.imageEngine
  return context.provider
}

function preferredTier(tiers: FashnResolution[], current: FashnResolution): FashnResolution | null {
  if (tiers.includes(current)) return current
  if (tiers.includes('2k')) return '2k'
  return tiers[0] ?? null
}

export function buildStudioResolutionUiState(
  context: StudioResolutionContext,
  current: { aspectRatio: string; resolution: FashnResolution },
): StudioResolutionUiState {
  const engine = resolveFinalStudioImageEngine(context)
  if (!engine) {
    return {
      kind: 'video',
      engine,
      contractEngine: null,
      labelBn: 'ভিডিও আউটপুট',
      detailBn: 'ইমেজ রেজোলিউশন নির্বাচন এই মোডে প্রযোজ্য নয়।',
      supportedAspects: [],
      supportedTiers: [],
      aspectRatio: null,
      resolution: null,
      resolutionOptions: [],
    }
  }

  const contractEngine: StudioImageEngine = engine === 'family_composite'
    ? context.vtonEngine === 'fal_fashn_v16' || context.vtonEngine === 'fal_idm_vton'
      ? 'fal_fashn_v16'
      : 'fashn'
    : engine
  const contract = getResolutionContract(contractEngine)
  const labelBn = engine === 'family_composite'
    ? `প্রোটেক্টেড কম্পোজিট · ${contract.labelBn}`
    : contract.labelBn
  const detailBn = engine === 'family_composite'
    ? `ফাইনাল কম্পোজিটের পিক্সেল ${contract.labelBn} অনুসরণ করে। ${contract.detailBn}`
    : contract.detailBn
  if (contract.kind !== 'tiered') {
    return {
      kind: contract.kind,
      engine,
      contractEngine,
      labelBn,
      detailBn,
      supportedAspects: [],
      supportedTiers: [],
      aspectRatio: null,
      resolution: null,
      resolutionOptions: [],
    }
  }

  const sourceDerivedFashnAspect =
    contractEngine === 'fashn'
    && (context.mode === 'model_swap' || context.mode === 'edit')
  const supportedAspects =
    contractEngine === 'fashn' && context.mode === 'face_to_model'
      ? contract.supportedAspects.filter((aspect) =>
        ['1:1', '4:5', '3:4', '2:3', '9:16'].includes(aspect))
      : contract.supportedAspects

  if (sourceDerivedFashnAspect) {
    const supportedTiers = contract.supportedTiers
    const resolution = preferredTier(supportedTiers, current.resolution)
    return {
      kind: 'tiered',
      engine,
      contractEngine,
      labelBn,
      detailBn: `${detailBn} আউটপুট অনুপাত সোর্স ছবি থেকে নির্ধারিত হবে।`,
      supportedAspects: [],
      supportedTiers,
      aspectRatio: null,
      resolution,
      resolutionOptions: supportedTiers.map((tier) => ({
        value: tier,
        label: resolutionOptionLabel(contractEngine, tier, current.aspectRatio),
      })),
    }
  }

  const aspectRatio = supportedAspects.includes(current.aspectRatio as StudioAspectRatio)
    ? current.aspectRatio as StudioAspectRatio
    : supportedAspects[0] ?? null
  const supportedTiers = aspectRatio ? supportedTiersForAspect(contractEngine, aspectRatio) : []
  const resolution = preferredTier(supportedTiers, current.resolution)

  if (!aspectRatio || !resolution) {
    return {
      kind: 'unsupported',
      engine,
      contractEngine,
      labelBn: 'এই কম্বিনেশন সমর্থিত নয়',
      detailBn: 'ইঞ্জিন বা অনুপাত বদলে আবার চেষ্টা করুন।',
      supportedAspects,
      supportedTiers,
      aspectRatio,
      resolution,
      resolutionOptions: [],
    }
  }

  return {
    kind: 'tiered',
    engine,
    contractEngine,
    labelBn,
    detailBn,
    supportedAspects,
    supportedTiers,
    aspectRatio,
    resolution,
    resolutionOptions: supportedTiers.map((tier) => ({
      value: tier,
      label: resolutionOptionLabel(contractEngine, tier, aspectRatio),
    })),
  }
}

export function resolutionFieldsForRun(
  state: StudioResolutionUiState,
): { aspectRatio?: StudioAspectRatio; resolution?: FashnResolution } {
  return state.kind === 'tiered' && state.resolution
    ? {
      ...(state.aspectRatio ? { aspectRatio: state.aspectRatio } : {}),
      resolution: state.resolution,
    }
    : {}
}

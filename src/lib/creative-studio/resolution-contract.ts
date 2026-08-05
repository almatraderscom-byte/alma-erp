import type { FashnResolution } from '@/lib/fashn/types'

export type StudioImageEngine =
  | 'fashn'
  | 'fal_fashn_v16'
  | 'fal_idm_vton'
  | 'fal_flux_fill'
  | 'xai_imagine'
  | 'gemini'
  | 'gpt'
  | 'seedream'

export type StudioAspectRatio = '4:5' | '1:1' | '9:16' | '16:9' | '3:4'

export type ImageDimensions = {
  width: number
  height: number
}

export type ResolutionContract = {
  kind: 'tiered' | 'fixed' | 'source'
  engine: StudioImageEngine
  supportedTiers: FashnResolution[]
  supportedAspects: StudioAspectRatio[]
  labelBn: string
  detailBn: string
  exactDimensions: Partial<Record<FashnResolution, Partial<Record<StudioAspectRatio, ImageDimensions>>>>
}

const STUDIO_ASPECTS: StudioAspectRatio[] = ['4:5', '1:1', '9:16', '16:9']
const ALL_TIERS: FashnResolution[] = ['1k', '2k', '4k']

const GEMINI_DIMENSIONS: ResolutionContract['exactDimensions'] = {
  '1k': {
    '1:1': { width: 1024, height: 1024 },
    '4:5': { width: 928, height: 1152 },
    '9:16': { width: 768, height: 1376 },
    '16:9': { width: 1376, height: 768 },
  },
  '2k': {
    '1:1': { width: 2048, height: 2048 },
    '4:5': { width: 1856, height: 2304 },
    '9:16': { width: 1536, height: 2752 },
    '16:9': { width: 2752, height: 1536 },
  },
  '4k': {
    '1:1': { width: 4096, height: 4096 },
    '4:5': { width: 3712, height: 4608 },
    '9:16': { width: 3072, height: 5504 },
    '16:9': { width: 5504, height: 3072 },
  },
}

const GPT_DIMENSIONS: ResolutionContract['exactDimensions'] = {
  '1k': GEMINI_DIMENSIONS['1k'],
  '2k': GEMINI_DIMENSIONS['2k'],
  '4k': {
    '9:16': { width: 2160, height: 3840 },
    '16:9': { width: 3840, height: 2160 },
  },
}

const SEEDREAM_DIMENSIONS: ResolutionContract['exactDimensions'] = {
  '1k': GEMINI_DIMENSIONS['1k'],
  '2k': {
    '1:1': { width: 2048, height: 2048 },
    '4:5': { width: 1824, height: 2272 },
    '9:16': { width: 1536, height: 2720 },
    '16:9': { width: 2720, height: 1536 },
  },
}

const CONTRACTS: Record<StudioImageEngine, ResolutionContract> = {
  fashn: {
    kind: 'tiered',
    engine: 'fashn',
    supportedTiers: ALL_TIERS,
    supportedAspects: ['4:5', '1:1', '9:16', '16:9', '3:4'],
    labelBn: 'FASHN নেটিভ রেজোলিউশন',
    detailBn: 'আসল ছবির পিক্সেল যাচাই করে 1K/2K/4K নিশ্চিত করা হবে।',
    // FASHN documents approximate 1/4/16 MP tiers and returns the exact
    // aspect-dependent dimensions with the artifact; never pre-label them as
    // Gemini's dimensions.
    exactDimensions: {},
  },
  fal_fashn_v16: {
    kind: 'fixed',
    engine: 'fal_fashn_v16',
    supportedTiers: [],
    supportedAspects: [],
    labelBn: 'নেটিভ 864×1296',
    detailBn: 'Fal FASHN v1.6-এর আউটপুট স্থির 864×1296; 2K/4K সমর্থিত নয়।',
    exactDimensions: {},
  },
  fal_idm_vton: {
    kind: 'fixed',
    engine: 'fal_idm_vton',
    supportedTiers: [],
    supportedAspects: [],
    labelBn: 'প্রোভাইডার নেটিভ সাইজ',
    detailBn: 'এই পরীক্ষামূলক মডেলের জন্য যাচাইকৃত 2K/4K চুক্তি নেই।',
    exactDimensions: {},
  },
  fal_flux_fill: {
    kind: 'source',
    engine: 'fal_flux_fill',
    supportedTiers: [],
    supportedAspects: [],
    labelBn: 'সোর্স ছবির পিক্সেল',
    detailBn: 'মাস্কড এডিটে মূল ছবির width×height অপরিবর্তিত থাকে।',
    exactDimensions: {},
  },
  xai_imagine: {
    kind: 'tiered',
    engine: 'xai_imagine',
    supportedTiers: ['1k', '2k'],
    supportedAspects: ['3:4', '1:1', '9:16', '16:9'],
    labelBn: 'Grok Imagine নেটিভ 1K/2K',
    detailBn: 'xAI 4K বা 4:5 সমর্থন করে না; ফলের আসল পিক্সেল যাচাই হবে।',
    exactDimensions: {
      '1k': {
        '1:1': { width: 1024, height: 1024 },
      },
      '2k': {
        '1:1': { width: 2048, height: 2048 },
      },
    },
  },
  gemini: {
    kind: 'tiered',
    engine: 'gemini',
    supportedTiers: ALL_TIERS,
    supportedAspects: STUDIO_ASPECTS,
    labelBn: 'Gemini নেটিভ 1K/2K/4K',
    detailBn: 'নির্বাচিত অনুপাতের exact Gemini পিক্সেল সাইজ পাঠানো ও যাচাই হবে।',
    exactDimensions: GEMINI_DIMENSIONS,
  },
  gpt: {
    kind: 'tiered',
    engine: 'gpt',
    supportedTiers: ALL_TIERS,
    supportedAspects: STUDIO_ASPECTS,
    labelBn: 'GPT Image 2 exact size',
    detailBn: '4K শুধু 16:9 ও 9:16-এ সমর্থিত; square/4:5 4K সীমার বাইরে।',
    exactDimensions: GPT_DIMENSIONS,
  },
  seedream: {
    kind: 'tiered',
    engine: 'seedream',
    supportedTiers: ['1k', '2k'],
    supportedAspects: STUDIO_ASPECTS,
    labelBn: 'Seedream নেটিভ 1K/2K',
    detailBn: 'Seedream-এর সর্বোচ্চ 4,194,304 পিক্সেল; 4K সমর্থিত নয়।',
    exactDimensions: SEEDREAM_DIMENSIONS,
  },
}

export function getResolutionContract(engine: StudioImageEngine): ResolutionContract {
  return CONTRACTS[engine]
}

export function supportedTiersForAspect(
  engine: StudioImageEngine,
  aspectRatio: string,
): FashnResolution[] {
  const contract = getResolutionContract(engine)
  if (contract.kind !== 'tiered') return []
  return contract.supportedTiers.filter((tier) => {
    if (engine !== 'gpt' || tier !== '4k') return true
    return aspectRatio === '9:16' || aspectRatio === '16:9'
  })
}

export function exactDimensionsFor(
  engine: StudioImageEngine,
  tier: FashnResolution,
  aspectRatio: string,
): ImageDimensions | null {
  const contract = getResolutionContract(engine)
  return contract.exactDimensions[tier]?.[aspectRatio as StudioAspectRatio] ?? null
}

export function assertResolutionRequest(input: {
  engine: StudioImageEngine
  resolution?: string
  aspectRatio?: string
}): void {
  const contract = getResolutionContract(input.engine)
  const resolution = input.resolution?.toLowerCase()
  const aspectRatio = input.aspectRatio

  if (contract.kind !== 'tiered') {
    if (resolution) throw new Error(`resolution_not_applicable:${input.engine}`)
    return
  }
  if (!resolution || !ALL_TIERS.includes(resolution as FashnResolution)) {
    throw new Error('resolution_required')
  }
  if ((!aspectRatio && input.engine !== 'fashn')
    || (aspectRatio && !contract.supportedAspects.includes(aspectRatio as StudioAspectRatio))) {
    throw new Error(`aspect_ratio_unsupported:${input.engine}:${aspectRatio ?? 'missing'}`)
  }
  if (!supportedTiersForAspect(input.engine, aspectRatio ?? 'source').includes(resolution as FashnResolution)) {
    throw new Error(`resolution_unsupported:${input.engine}:${resolution}:${aspectRatio}`)
  }
}

export function resolutionOptionLabel(
  engine: StudioImageEngine,
  tier: FashnResolution,
  aspectRatio: string,
): string {
  const dimensions = exactDimensionsFor(engine, tier, aspectRatio)
  return dimensions
    ? `${tier.toUpperCase()} · ${dimensions.width}×${dimensions.height}`
    : tier.toUpperCase()
}

import type { StudioIconName } from './StudioV2Icon'

export type ImageModeId =
  | 'generate'
  | 'product_to_model'
  | 'try_on'
  | 'swap'
  | 'face'
  | 'edit'
  | 'reel'

export type GalleryAssetType =
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'avatar'
  | 'project'

export type GalleryDensity = 'large' | 'comfortable' | 'compact' | 'list'

export type CapabilityDeskId =
  | 'projects'
  | 'systems'
  | 'review'
  | 'operations'
  | 'voice'
  | 'audio'
  | 'campaign'

export type ProductFixture = {
  id: string
  name: string
  code: string
  type: string
  resolution: string
  status: 'ready' | 'needs_reference'
  tone: GalleryTone
}

export type AvatarFixture = {
  id: string
  name: string
  role: 'single' | 'father' | 'mother' | 'son' | 'daughter'
  version: string
  imageCount: number
  owner: string
  brand: string
  status: 'active' | 'building' | 'draft'
  canonical: boolean
  tone: GalleryTone
}

export type GalleryTone =
  | 'coral'
  | 'sand'
  | 'sage'
  | 'ink'
  | 'sky'
  | 'rose'
  | 'clay'
  | 'ivory'

export type GalleryAssetFixture = {
  id: string
  title: string
  type: GalleryAssetType
  subtype: string
  tone: GalleryTone
  status: 'ready' | 'approved' | 'review' | 'draft' | 'qc_failed' | 'archived'
  statusLabel: string
  provider: string
  resolution: string
  aspect: string
  date: string
  project: string
  source: string
  cost: string
}

export type ImageProviderFixture = {
  id: string
  label: string
  badge: string
  commercial: boolean
  researchOnly?: boolean
  modes: readonly ImageModeId[]
  resolutions: readonly ('1K' | '2K')[]
  note: string
  estimate: Record<'1K' | '2K', number | null>
}

export type VideoModelFixture = {
  id: string
  label: string
  provider: string
  durations: readonly number[]
  resolutions: readonly ('720p' | '1080p')[]
  aspects: readonly ('9:16' | '1:1' | '16:9')[]
  supportsAudio: boolean
  note: string
  estimatePerSecondBdt: number
}

export type ImageModeFixture = {
  id: ImageModeId
  label: string
  shortLabel: string
  description: string
  icon: StudioIconName
  product: 'hidden' | 'optional' | 'required'
  avatar: 'hidden' | 'optional' | 'required'
  source: 'hidden' | 'optional' | 'required'
  extraReference: 'hidden' | 'optional'
  family: boolean
}

export const IMAGE_MODES: readonly ImageModeFixture[] = [
  {
    id: 'generate',
    label: 'Generate',
    shortLabel: 'Text → image',
    description: 'Start from a prompt with Grok Imagine. No product or identity reference is sent.',
    icon: 'agent',
    product: 'hidden',
    avatar: 'hidden',
    source: 'hidden',
    extraReference: 'hidden',
    family: false,
  },
  {
    id: 'product_to_model',
    label: 'Product → Model',
    shortLabel: 'Styled catalog',
    description: 'Place an ERP-linked garment on one approved model or a deterministic family preset.',
    icon: 'image',
    product: 'required',
    avatar: 'optional',
    source: 'hidden',
    extraReference: 'hidden',
    family: true,
  },
  {
    id: 'try_on',
    label: 'Try-On',
    shortLabel: 'Garment fidelity',
    description: 'Use an approved product and identity reference with explicit garment placement.',
    icon: 'layers',
    product: 'required',
    avatar: 'required',
    source: 'hidden',
    extraReference: 'hidden',
    family: true,
  },
  {
    id: 'swap',
    label: 'Swap',
    shortLabel: 'Model swap',
    description: 'Keep the source composition while replacing the model with an approved identity.',
    icon: 'projects',
    product: 'optional',
    avatar: 'required',
    source: 'required',
    extraReference: 'hidden',
    family: false,
  },
  {
    id: 'face',
    label: 'Face',
    shortLabel: 'Face → model',
    description: 'Apply an approved face identity while retaining the product and scene context.',
    icon: 'voice',
    product: 'optional',
    avatar: 'required',
    source: 'hidden',
    extraReference: 'hidden',
    family: false,
  },
  {
    id: 'edit',
    label: 'Edit',
    shortLabel: 'Directed image edit',
    description: 'Edit a source image, optionally with one extra visual reference.',
    icon: 'inspector',
    product: 'hidden',
    avatar: 'hidden',
    source: 'required',
    extraReference: 'optional',
    family: false,
  },
  {
    id: 'reel',
    label: 'Reel',
    shortLabel: 'Linked image → video',
    description: 'Send a selected source into the Video Lab; generation remains separately gated.',
    icon: 'video',
    product: 'optional',
    avatar: 'hidden',
    source: 'required',
    extraReference: 'hidden',
    family: false,
  },
] as const

export const IMAGE_PROVIDERS: readonly ImageProviderFixture[] = [
  {
    id: 'grok',
    label: 'Grok Imagine',
    badge: 'Commercial',
    commercial: true,
    modes: ['generate', 'product_to_model', 'try_on', 'swap', 'face', 'edit'],
    resolutions: ['1K', '2K'],
    note: 'Up to three references. Native 1K/2K only; no synthetic 4K upscale.',
    estimate: { '1K': 6.25, '2K': 8.75 },
  },
  {
    id: 'fashn-direct',
    label: 'FASHN direct',
    badge: 'Production',
    commercial: true,
    modes: ['product_to_model', 'try_on', 'swap', 'face', 'edit'],
    resolutions: ['1K'],
    note: 'Single-person fidelity path. Delivery dimensions are verified from the result.',
    estimate: { '1K': 10.5, '2K': null },
  },
  {
    id: 'fal-fashn',
    label: 'Fal · FASHN v1.6',
    badge: 'Commercial',
    commercial: true,
    modes: ['try_on'],
    resolutions: ['1K'],
    note: 'Commercial try-on adapter. Fixed provider output; 2K/4K are unavailable.',
    estimate: { '1K': 9.38, '2K': null },
  },
  {
    id: 'gemini-draft',
    label: 'Gemini draft',
    badge: 'Fallback',
    commercial: true,
    modes: ['product_to_model', 'try_on'],
    resolutions: ['1K'],
    note: 'Draft/family fallback. Never selected silently when another provider fails.',
    estimate: { '1K': 3.75, '2K': null },
  },
  {
    id: 'idm-vton',
    label: 'IDM-VTON',
    badge: 'Research only',
    commercial: false,
    researchOnly: true,
    modes: ['try_on'],
    resolutions: ['1K'],
    note: 'Evaluation only. Owner policy blocks commercial campaign execution.',
    estimate: { '1K': 0, '2K': null },
  },
  {
    id: 'flux-fill',
    label: 'FLUX Fill',
    badge: 'Masked repair',
    commercial: true,
    modes: ['edit'],
    resolutions: ['1K', '2K'],
    note: 'Mask-scoped repair priced by delivered megapixel. Source outside the mask stays fixed.',
    estimate: { '1K': 6.25, '2K': 25 },
  },
] as const

export const VIDEO_MODELS: readonly VideoModelFixture[] = [
  {
    id: 'veo-preview',
    label: 'Veo 3.1 preview',
    provider: 'Google',
    durations: [4, 5, 6, 7, 8],
    resolutions: ['720p'],
    aspects: ['9:16', '16:9'],
    supportsAudio: true,
    note: 'One provider clip is 4–8 sec. 16/24 sec reels are deterministic 2/3 × 8 sec chains.',
    estimatePerSecondBdt: 18.75,
  },
  {
    id: 'owned-local',
    label: 'Owned footage recipe',
    provider: 'ALMA local',
    durations: [15, 30, 60],
    resolutions: ['720p', '1080p'],
    aspects: ['9:16', '1:1', '16:9'],
    supportsAudio: true,
    note: 'No generation. Preserves source resolution up to 1080p through hard recipe edits.',
    estimatePerSecondBdt: 0,
  },
] as const

export const PRODUCTS: readonly ProductFixture[] = [
  {
    id: 'panjabi-coral',
    name: 'Coral Embroidered Panjabi',
    code: 'AL-EID-042',
    type: 'ERP product · front mannequin',
    resolution: '2400 × 3000',
    status: 'ready',
    tone: 'coral',
  },
  {
    id: 'panjabi-sage',
    name: 'Sage Cotton Panjabi',
    code: 'AL-SUM-118',
    type: 'ERP product · flat lay',
    resolution: '2048 × 2560',
    status: 'ready',
    tone: 'sage',
  },
  {
    id: 'kids-ivory',
    name: 'Ivory Kids Kurta',
    code: 'AL-KID-027',
    type: 'ERP product · supplier image',
    resolution: '720 × 900',
    status: 'needs_reference',
    tone: 'ivory',
  },
] as const

export const AVATARS: readonly AvatarFixture[] = [
  {
    id: 'maruf-test',
    name: 'Maruf Test',
    role: 'single',
    version: 'Avatar v4',
    imageCount: 8,
    owner: 'Maruf Billah',
    brand: 'ALMA Lifestyle',
    status: 'active',
    canonical: true,
    tone: 'ink',
  },
  {
    id: 'father-01',
    name: 'ALMA Father 01',
    role: 'father',
    version: 'Identity v3',
    imageCount: 10,
    owner: 'Brand library',
    brand: 'ALMA Lifestyle',
    status: 'active',
    canonical: true,
    tone: 'clay',
  },
  {
    id: 'mother-02',
    name: 'ALMA Mother 02',
    role: 'mother',
    version: 'Identity v2',
    imageCount: 7,
    owner: 'Brand library',
    brand: 'ALMA Lifestyle',
    status: 'active',
    canonical: false,
    tone: 'rose',
  },
  {
    id: 'son-01',
    name: 'ALMA Son 01',
    role: 'son',
    version: 'Identity draft',
    imageCount: 4,
    owner: 'Brand library',
    brand: 'ALMA Lifestyle',
    status: 'draft',
    canonical: false,
    tone: 'sky',
  },
  {
    id: 'daughter-01',
    name: 'ALMA Daughter 01',
    role: 'daughter',
    version: 'Building',
    imageCount: 6,
    owner: 'Brand library',
    brand: 'ALMA Lifestyle',
    status: 'building',
    canonical: false,
    tone: 'sage',
  },
] as const

export const IMAGE_RECIPES = [
  'Product launch visual',
  'Social media content',
  'Product display image',
  'Virtual try-on',
  'Product to model',
  'Combined listing',
] as const

export const FAMILY_PRESETS = [
  'Single',
  'বাবা + ছেলে',
  'মা + মেয়ে',
  'মা + ছেলে',
  'বাবা + মেয়ে',
  'কাপল',
  'পুরো ফ্যামিলি',
] as const

export const BACKGROUNDS = [
  'Studio',
  'Outdoor BD',
  'Festival',
  'Lifestyle',
  'Custom',
] as const

export const IMAGE_TEMPLATES = [
  {
    id: 'editorial-product',
    title: 'Quiet product portrait',
    meta: 'Product → Model · 4:5',
    recipe: 'Editorial Warm v7',
    tone: 'coral' as const,
  },
  {
    id: 'family-story',
    title: 'Family story frame',
    meta: 'Try-On · 9:16',
    recipe: 'Eid Family v5',
    tone: 'sand' as const,
  },
  {
    id: 'catalog-clean',
    title: 'Clean catalog',
    meta: 'Product → Model · 1:1',
    recipe: 'Catalog Neutral v3',
    tone: 'ivory' as const,
  },
  {
    id: 'offer-social',
    title: 'Offer social crop',
    meta: 'Edit · 4:5',
    recipe: 'Commerce Bold v2',
    tone: 'clay' as const,
  },
] as const

export const VIDEO_TEMPLATES = [
  {
    id: 'premium-turn',
    title: 'Premium fabric turn',
    meta: '6 sec · 9:16',
    source: 'Image → video',
    tone: 'coral' as const,
  },
  {
    id: 'family-shoot',
    title: 'Family Shoot',
    meta: '15 / 30 / 60 sec',
    source: 'Owned footage recipe',
    tone: 'sand' as const,
  },
  {
    id: 'product-showcase',
    title: 'Product Showcase',
    meta: '15 / 30 / 60 sec',
    source: 'Owned footage recipe',
    tone: 'sage' as const,
  },
  {
    id: 'offer-promo',
    title: 'Offer Promo',
    meta: '15 / 30 sec',
    source: 'Owned footage recipe',
    tone: 'clay' as const,
  },
] as const

const GALLERY_BASE: readonly Omit<GalleryAssetFixture, 'id' | 'date'>[] = [
  {
    title: 'Coral Panjabi · Hero',
    type: 'image',
    subtype: 'Product → Model',
    tone: 'coral',
    status: 'approved',
    statusLabel: 'Approved',
    provider: 'FASHN direct',
    resolution: '1080 × 1350',
    aspect: '4:5',
    project: 'Coral Panjabi Launch',
    source: 'ERP · AL-EID-042',
    cost: '৳10.50',
  },
  {
    title: 'Father + Son · Select 02',
    type: 'image',
    subtype: 'Family chain',
    tone: 'sand',
    status: 'ready',
    statusLabel: 'QC passed',
    provider: 'FASHN + Gemini',
    resolution: '1080 × 1350',
    aspect: '4:5',
    project: 'Father & Son Story',
    source: 'Protected composite',
    cost: '৳24.20',
  },
  {
    title: 'Catalog · Sage 04',
    type: 'image',
    subtype: 'Product → Model',
    tone: 'sage',
    status: 'review',
    statusLabel: 'Needs review',
    provider: 'Grok Imagine',
    resolution: '2048 × 2560',
    aspect: '4:5',
    project: 'Summer Catalog Refresh',
    source: 'ERP · AL-SUM-118',
    cost: '৳8.75',
  },
  {
    title: 'Embroidery detail · Repair',
    type: 'image',
    subtype: 'Masked repair',
    tone: 'ink',
    status: 'qc_failed',
    statusLabel: 'QC failed',
    provider: 'FLUX Fill',
    resolution: '1536 × 1536',
    aspect: '1:1',
    project: 'Coral Panjabi Launch',
    source: 'Mask · MSK-204',
    cost: '৳14.75',
  },
  {
    title: 'Fabric turn · Select',
    type: 'video',
    subtype: 'AI reel source',
    tone: 'coral',
    status: 'ready',
    statusLabel: 'Ready',
    provider: 'Veo 3.1 preview',
    resolution: '720 × 1280 delivered',
    aspect: '9:16',
    project: 'Coral Panjabi Launch',
    source: 'Hero image v6',
    cost: '৳112.50',
  },
  {
    title: 'Family Shoot · Cut 03',
    type: 'video',
    subtype: 'Owned footage',
    tone: 'sand',
    status: 'review',
    statusLabel: 'Caption review',
    provider: 'ALMA local',
    resolution: '1080 × 1920',
    aspect: '9:16',
    project: 'Father & Son Story',
    source: 'Owned · VID-118',
    cost: '৳0 edit',
  },
  {
    title: 'Product showcase · Wide',
    type: 'video',
    subtype: 'Owned footage',
    tone: 'sage',
    status: 'approved',
    statusLabel: 'Approved',
    provider: 'ALMA local',
    resolution: '1920 × 1080',
    aspect: '16:9',
    project: 'Summer Catalog Refresh',
    source: 'Owned · VID-129',
    cost: '৳0 edit',
  },
  {
    title: 'Eid pulse · 24 sec',
    type: 'audio',
    subtype: 'Music',
    tone: 'sand',
    status: 'approved',
    statusLabel: 'Licensed',
    provider: 'ALMA library',
    resolution: '48 kHz · Stereo',
    aspect: '00:24',
    project: 'Coral Panjabi Launch',
    source: 'Owner-approved library',
    cost: '৳0 reuse',
  },
  {
    title: 'Soft fabric movement',
    type: 'audio',
    subtype: 'SFX',
    tone: 'sage',
    status: 'ready',
    statusLabel: 'Cleared',
    provider: 'ALMA recording',
    resolution: '48 kHz · Mono',
    aspect: '00:02',
    project: 'Coral Panjabi Launch',
    source: 'Owned recording',
    cost: '৳0 reuse',
  },
  {
    title: 'Owner voice · Active v3',
    type: 'voice',
    subtype: 'Consent-pinned voice',
    tone: 'sky',
    status: 'approved',
    statusLabel: 'Owner only',
    provider: 'Voice library',
    resolution: '48 kHz',
    aspect: 'v3',
    project: 'Brand library',
    source: 'Consent · VC-2026-04',
    cost: 'Gate required',
  },
  {
    title: 'Maruf Test',
    type: 'avatar',
    subtype: 'Identity avatar',
    tone: 'ink',
    status: 'approved',
    statusLabel: 'Active',
    provider: 'ALMA identity sheet',
    resolution: '8 angles',
    aspect: 'v4',
    project: 'Brand library',
    source: 'Strict brand isolation',
    cost: 'Approved',
  },
  {
    title: 'ALMA Father 01',
    type: 'avatar',
    subtype: 'Saved model · father',
    tone: 'clay',
    status: 'approved',
    statusLabel: 'Active',
    provider: 'ALMA identity sheet',
    resolution: '10 angles',
    aspect: 'v3',
    project: 'Brand library',
    source: 'Strict brand isolation',
    cost: 'Approved',
  },
  {
    title: 'Coral Panjabi Launch',
    type: 'project',
    subtype: 'Video project',
    tone: 'coral',
    status: 'review',
    statusLabel: 'Owner review',
    provider: 'Composition v12',
    resolution: '5 tracks',
    aspect: '9:16',
    project: 'Eid 2026',
    source: 'Folder · Launches',
    cost: '৳248 actual',
  },
  {
    title: 'Summer Catalog Refresh',
    type: 'project',
    subtype: 'Image collection',
    tone: 'sage',
    status: 'approved',
    statusLabel: 'Approved',
    provider: '32 assets',
    resolution: '3 deliverables',
    aspect: 'Mixed',
    project: 'Everyday Edit',
    source: 'Folder · Catalog',
    cost: '৳615 actual',
  },
] as const

export const GALLERY_ASSETS: readonly GalleryAssetFixture[] = Array.from(
  { length: 28 },
  (_, index) => {
    const base = GALLERY_BASE[index % GALLERY_BASE.length]
    const duplicate = Math.floor(index / GALLERY_BASE.length)
    return {
      ...base,
      id: `asset-${index + 1}`,
      title: duplicate ? `${base.title} · v${duplicate + 1}` : base.title,
      date: index < 5 ? 'Today' : index < 11 ? 'Yesterday' : `Jul ${24 - (index % 12)}, 2026`,
    }
  },
)

export const GALLERY_TYPES: ReadonlyArray<{
  id: 'all' | GalleryAssetType
  label: string
  icon: StudioIconName
}> = [
  { id: 'all', label: 'All assets', icon: 'assets' },
  { id: 'image', label: 'Images', icon: 'image' },
  { id: 'video', label: 'Video', icon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'voice', label: 'Voices', icon: 'voice' },
  { id: 'avatar', label: 'Avatars', icon: 'projects' },
  { id: 'project', label: 'Projects', icon: 'folder' },
] as const

export const MASK_REPAIR_PRESETS = [
  {
    id: 'replace_background',
    label: 'Replace background',
    hint: 'Brush only the surrounding background; preserve the person or product.',
  },
  {
    id: 'remove_object',
    label: 'Remove object / mark',
    hint: 'Brush only the object or blemish that should be reconstructed.',
  },
  {
    id: 'repair_hand',
    label: 'Repair hand / detail',
    hint: 'Brush the hand, fingers or small defect only.',
  },
  {
    id: 'contact_shadow',
    label: 'Add contact shadow',
    hint: 'Brush the floor area beneath the person or product.',
  },
  {
    id: 'extend_canvas',
    label: 'Extend canvas',
    hint: 'The border mask is prepared automatically for outpainting.',
  },
  {
    id: 'custom',
    label: 'Custom prompt',
    hint: 'Brush the target area and describe the exact local change.',
  },
] as const

export const FINISH_LAYOUTS = [
  {
    id: 'lifestyle',
    label: 'Lifestyle poster',
    detail: 'Full-image poster with headline, hook, offer and product code.',
  },
  {
    id: 'model_overlay',
    label: 'Model overlay',
    detail: 'Brand copy and optional footer layer over the selected model image.',
  },
  {
    id: 'product_card',
    label: 'Product card',
    detail: 'Structured product panel while preserving the original source.',
  },
] as const

export const FINISH_THEMES = ['Default', 'Eid', 'Puja', 'Boishakh', 'Winter'] as const

export const VIDEO_FINISH_TEMPLATES = [
  'Price pop',
  'Lower third · code + name',
  'Logo watermark',
  'End card · CTA / code / price',
  'Countdown · days',
] as const

export function imageProviderSupports(
  providerId: string,
  mode: ImageModeId,
  resolution: '1K' | '2K' | '4K',
) {
  const provider = IMAGE_PROVIDERS.find((item) => item.id === providerId)
  if (!provider) return false
  if (resolution === '4K') return false
  return provider.modes.includes(mode) && provider.resolutions.includes(resolution)
}

export function compatibleImageProviders(mode: ImageModeId) {
  return IMAGE_PROVIDERS.filter((provider) => provider.modes.includes(mode))
}

export function videoModelSupports(
  modelId: string,
  duration: number,
  resolution: '720p' | '1080p' | '4K',
  aspect: '9:16' | '1:1' | '16:9',
) {
  const model = VIDEO_MODELS.find((item) => item.id === modelId)
  if (!model || resolution === '4K') return false
  return (
    model.durations.includes(duration) &&
    model.resolutions.includes(resolution) &&
    model.aspects.includes(aspect)
  )
}

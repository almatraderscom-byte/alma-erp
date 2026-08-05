export type CreateKind =
  | 'image'
  | 'video'
  | 'voice'
  | 'audio'
  | 'campaign'
  | 'longform'

export type EditorTool = 'image' | 'video' | 'voice' | 'audio' | 'library'

export type ProjectState = 'editing' | 'review' | 'rendering' | 'approved'

export type StudioProject = {
  id: string
  title: string
  collection: string
  format: string
  state: ProjectState
  stateLabel: string
  progress: number
  activity: string
  owner: string
  collaborators: readonly string[]
  preview: 'coral' | 'sand' | 'ink' | 'sage'
  kind: CreateKind
}

export type AssetFixture = {
  id: string
  name: string
  meta: string
  type: 'image' | 'video' | 'voice' | 'music' | 'sfx'
  tone: 'coral' | 'sand' | 'ink' | 'sage' | 'sky'
  status: string
  provenance: string
}

export const CREATE_OPTIONS: ReadonlyArray<{
  id: CreateKind
  title: string
  description: string
  detail: string
}> = [
  {
    id: 'image',
    title: 'Image',
    description: 'Product, campaign and catalog imagery',
    detail: 'Auto · Advanced · finishing',
  },
  {
    id: 'video',
    title: 'Video / Reel',
    description: 'Short-form edits, reels and AI-assisted video',
    detail: '9:16 · 1:1 · 16:9',
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'Approved voices, narration and dubbing',
    detail: 'Consent-gated · transcript',
  },
  {
    id: 'audio',
    title: 'Audio',
    description: 'Music beds, voice mix and sound effects',
    detail: 'Library · Music · SFX',
  },
  {
    id: 'campaign',
    title: 'Campaign Pack',
    description: 'Coordinated assets across every channel',
    detail: 'Brief → variants → review',
  },
  {
    id: 'longform',
    title: 'Long-form',
    description: 'Narrative video, chapters and rich captions',
    detail: 'Timeline · chapters · transcript',
  },
] as const

export const PROJECTS: readonly StudioProject[] = [
  {
    id: 'coral-launch',
    title: 'Coral Panjabi Launch',
    collection: 'Eid 2026',
    format: '24 sec reel · 9:16',
    state: 'review',
    stateLabel: 'Owner review',
    progress: 68,
    activity: '12 min ago',
    owner: 'MB',
    collaborators: ['SA', 'RN'],
    preview: 'coral',
    kind: 'video',
  },
  {
    id: 'father-son',
    title: 'Father & Son Story',
    collection: 'Eid 2026',
    format: 'Campaign Pack · 7 assets',
    state: 'rendering',
    stateLabel: '2 jobs running',
    progress: 42,
    activity: '18 min ago',
    owner: 'SA',
    collaborators: ['MB', 'FA'],
    preview: 'sand',
    kind: 'campaign',
  },
  {
    id: 'summer-catalog',
    title: 'Summer Catalog Refresh',
    collection: 'Everyday Edit',
    format: '32 images · Catalog',
    state: 'approved',
    stateLabel: 'Approved',
    progress: 100,
    activity: 'Yesterday',
    owner: 'RN',
    collaborators: ['MB'],
    preview: 'sage',
    kind: 'image',
  },
  {
    id: 'craft-film',
    title: 'Made With Quiet Confidence',
    collection: 'Brand stories',
    format: '3 min 20 sec · 16:9',
    state: 'editing',
    stateLabel: 'Editing',
    progress: 31,
    activity: 'Friday',
    owner: 'FA',
    collaborators: ['SA'],
    preview: 'ink',
    kind: 'longform',
  },
] as const

export const REUSABLE_SYSTEMS = [
  {
    id: 'editorial-warm',
    kind: 'Recipe',
    name: 'Editorial Warm',
    meta: 'v7 · locked',
    detail: 'Image finish + caption rules',
  },
  {
    id: 'fashn-commercial',
    kind: 'Saved model',
    name: 'FASHN 1.6 Commercial',
    meta: 'Approved',
    detail: 'Garment fidelity · paid gate',
  },
  {
    id: 'eid-reel',
    kind: 'Template',
    name: 'Eid Story Reel',
    meta: '9:16 · 24 sec',
    detail: '5-shot rhythm + safe zones',
  },
  {
    id: 'catalog-pipeline',
    kind: 'Workflow',
    name: 'Catalog to Campaign',
    meta: 'Advanced',
    detail: 'ERP product → pack → review',
  },
] as const

export const ASSET_FIXTURES: readonly AssetFixture[] = [
  {
    id: 'hero',
    name: 'Coral Panjabi · Hero',
    meta: 'Image · 1080 × 1350',
    type: 'image',
    tone: 'coral',
    status: 'QC passed',
    provenance: 'ERP · AL-EID-042',
  },
  {
    id: 'family',
    name: 'Father + Son · Select 02',
    meta: 'Image · Recipe v7',
    type: 'image',
    tone: 'sand',
    status: 'Approved',
    provenance: 'Owned shoot · 2026-07-22',
  },
  {
    id: 'turn',
    name: 'Fabric turn · 6 sec',
    meta: 'Video · 9:16',
    type: 'video',
    tone: 'sage',
    status: 'Ready',
    provenance: 'Owned footage · VID-118',
  },
  {
    id: 'close-up',
    name: 'Embroidery close-up',
    meta: 'Video · 4 sec',
    type: 'video',
    tone: 'ink',
    status: 'Draft',
    provenance: 'Prototype placeholder',
  },
  {
    id: 'owner-voice',
    name: 'Owner voice · Active v3',
    meta: 'Voice · consent pinned',
    type: 'voice',
    tone: 'sky',
    status: 'Owner only',
    provenance: 'Consent VC-2026-04',
  },
  {
    id: 'eid-theme',
    name: 'Eid pulse · Approved',
    meta: 'Music · 00:24',
    type: 'music',
    tone: 'sand',
    status: 'Licensed',
    provenance: 'ALMA licensed library',
  },
  {
    id: 'fabric',
    name: 'Soft fabric movement',
    meta: 'SFX · 00:02',
    type: 'sfx',
    tone: 'sage',
    status: 'Cleared',
    provenance: 'ALMA owned recording',
  },
] as const

export const TOOL_COPY: Record<
  EditorTool,
  { eyebrow: string; title: string; hint: string }
> = {
  image: {
    eyebrow: 'VISUALS',
    title: 'Images',
    hint: 'Owned imagery, Auto and Advanced outputs',
  },
  video: {
    eyebrow: 'MOTION',
    title: 'Video',
    hint: 'Reels, owned shoots and AI-video entry points',
  },
  voice: {
    eyebrow: 'VOICE',
    title: 'Approved voices',
    hint: 'Consent, transcript and dubbing context',
  },
  audio: {
    eyebrow: 'SOUND',
    title: 'Music + SFX',
    hint: 'Licensed music, owner audio and effects',
  },
  library: {
    eyebrow: 'LIBRARY',
    title: 'Project library',
    hint: 'Assets, models, recipes and catalog links',
  },
}

export const CAPTION_WORDS = [
  { id: 'w1', text: 'ঈদের', at: '00:01.2' },
  { id: 'w2', text: 'নতুন', at: '00:01.8' },
  { id: 'w3', text: 'গল্প', at: '00:02.5' },
] as const

export function toolForCreateKind(kind: CreateKind): EditorTool {
  if (kind === 'image') return 'image'
  if (kind === 'voice') return 'voice'
  if (kind === 'audio') return 'audio'
  return 'video'
}

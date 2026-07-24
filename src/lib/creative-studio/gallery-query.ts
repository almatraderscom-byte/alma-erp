export const GALLERY_PAGE_SIZE = 24
export const GALLERY_MAX_PAGE_SIZE = 48

export type GalleryMediaFilter = 'all' | 'image' | 'video' | 'audio'
export type GalleryStateFilter = 'all' | 'ready' | 'qc_failed' | 'draft' | 'processing' | 'failed'
export type GalleryQcFilter = 'all' | 'pass' | 'fail'

export type GalleryFilters = {
  media: GalleryMediaFilter
  state: GalleryStateFilter
  qc: GalleryQcFilter
  query: string
  includeTest: boolean
}

export type GalleryCursor = {
  createdAt: string
  id: string
}

type SearchParamsReader = {
  get(name: string): string | null
}

const MEDIA_VALUES = new Set<GalleryMediaFilter>(['all', 'image', 'video', 'audio'])
const STATE_VALUES = new Set<GalleryStateFilter>(['all', 'ready', 'qc_failed', 'draft', 'processing', 'failed'])
const QC_VALUES = new Set<GalleryQcFilter>(['all', 'pass', 'fail'])

const PENDING_STATUSES = ['approved', 'pending', 'processing']
const FAILED_STATUSES = ['failed', 'error', 'rejected']

const QC_FAILED_WHERE = {
  OR: [
    { result: { path: ['qc', 'pass'], equals: false } },
    { result: { path: ['videoQc', 'pass'], equals: false } },
  ],
}

const QC_PASSED_WHERE = {
  OR: [
    { result: { path: ['qc', 'pass'], equals: true } },
    { result: { path: ['videoQc', 'pass'], equals: true } },
  ],
}

function oneOf<T extends string>(value: string | null, values: Set<T>, fallback: T): T {
  return value && values.has(value as T) ? (value as T) : fallback
}

export function normalizeGalleryFilters(params: SearchParamsReader): GalleryFilters {
  return {
    media: oneOf(params.get('media'), MEDIA_VALUES, 'all'),
    state: oneOf(params.get('state'), STATE_VALUES, 'all'),
    qc: oneOf(params.get('qc'), QC_VALUES, 'all'),
    query: (params.get('q') ?? '').trim().slice(0, 80),
    includeTest: params.get('includeTest') === '1',
  }
}

export function normalizeGalleryLimit(raw: string | null): number {
  const value = Number(raw ?? GALLERY_PAGE_SIZE)
  if (!Number.isFinite(value)) return GALLERY_PAGE_SIZE
  return Math.min(GALLERY_MAX_PAGE_SIZE, Math.max(12, Math.trunc(value)))
}

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeGalleryCursor(raw: string | null): GalleryCursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<GalleryCursor>
    if (
      typeof parsed.createdAt !== 'string'
      || !Number.isFinite(new Date(parsed.createdAt).getTime())
      || typeof parsed.id !== 'string'
      || parsed.id.length < 8
    ) return null
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return null
  }
}

export function buildGalleryCursorWhere(cursor: GalleryCursor): Record<string, unknown> {
  const createdAt = new Date(cursor.createdAt)
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { AND: [{ createdAt: { equals: createdAt } }, { id: { lt: cursor.id } }] },
    ],
  }
}

export function buildGalleryWhere(filters: GalleryFilters): Record<string, unknown> {
  const and: Array<Record<string, unknown>> = [
    { payload: { path: ['creativeStudio'], equals: true } },
  ]

  if (filters.media === 'image') and.push({ type: 'image_gen' })
  else if (filters.media === 'video') and.push({ type: { in: ['video_gen', 'video_edit'] } })
  else if (filters.media === 'audio') and.push({ type: 'audio_gen' })
  else and.push({ type: { in: ['image_gen', 'video_gen', 'video_edit', 'audio_gen'] } })

  if (!filters.includeTest) {
    and.push({
      NOT: {
        OR: [
          { payload: { path: ['testArtifact'], equals: true } },
          { payload: { path: ['e2e'], equals: true } },
          { payload: { path: ['videoName'], string_contains: 'e2e-' } },
          { summary: { contains: 'e2e-', mode: 'insensitive' } },
        ],
      },
    })
  }

  if (filters.query) {
    and.push({
      OR: [
        { summary: { contains: filters.query, mode: 'insensitive' } },
        { payload: { path: ['productCode'], string_contains: filters.query } },
        { payload: { path: ['videoName'], string_contains: filters.query } },
        { payload: { path: ['studioMode'], string_contains: filters.query } },
      ],
    })
  }

  if (filters.state === 'ready') {
    and.push({ status: 'executed' }, { NOT: QC_FAILED_WHERE })
  } else if (filters.state === 'qc_failed') {
    and.push({ status: 'executed' }, QC_FAILED_WHERE)
  } else if (filters.state === 'draft') {
    and.push({ status: { notIn: ['executed', ...PENDING_STATUSES, ...FAILED_STATUSES] } })
  } else if (filters.state === 'processing') {
    and.push({ status: { in: PENDING_STATUSES } })
  } else if (filters.state === 'failed') {
    and.push({ status: { in: FAILED_STATUSES } })
  }

  if (filters.qc === 'pass') and.push(QC_PASSED_WHERE)
  else if (filters.qc === 'fail') and.push(QC_FAILED_WHERE)

  return { AND: and }
}

export function mergeGalleryPage<T extends { id: string }>(fresh: T[], existing: T[]): T[] {
  const freshIds = new Set(fresh.map((item) => item.id))
  return [...fresh, ...existing.filter((item) => !freshIds.has(item.id))]
}

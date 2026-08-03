export const GALLERY_PAGE_SIZE = 24
export const GALLERY_MAX_PAGE_SIZE = 48

export type GalleryMediaFilter = 'all' | 'image' | 'video' | 'audio'
export type GalleryStateFilter = 'all' | 'ready' | 'review' | 'qc_failed' | 'draft' | 'processing' | 'failed'
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
const STATE_VALUES = new Set<GalleryStateFilter>(['all', 'ready', 'review', 'qc_failed', 'draft', 'processing', 'failed'])
const QC_VALUES = new Set<GalleryQcFilter>(['all', 'pass', 'fail'])

const PENDING_STATUSES = ['approved', 'pending', 'processing']
const FAILED_STATUSES = ['failed', 'error', 'rejected']

export const GALLERY_QC_FAILED_WHERE = {
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

export const GALLERY_TEST_ARTIFACT_WHERE = {
  OR: [
    { payload: { path: ['testArtifact'], equals: true } },
    { payload: { path: ['e2e'], equals: true } },
    { payload: { path: ['videoName'], string_contains: 'e2e-' } },
    { payload: { path: ['videoName'], string_contains: 'E2E-' } },
    { summary: { contains: 'e2e-', mode: 'insensitive' } },
  ],
}

/** Chain steps are implementation details; only the final signed artifact belongs in Gallery. */
export const GALLERY_INTERNAL_ARTIFACT_WHERE = {
  payload: { path: ['chainInternal'], equals: true },
}

export function isGalleryInternalArtifact(row: {
  payload?: Record<string, unknown> | null
}): boolean {
  return row.payload?.chainInternal === true
}

export function isGalleryTestArtifact(row: {
  payload?: Record<string, unknown> | null
  summary?: string | null
}): boolean {
  const payload = row.payload ?? {}
  return payload.testArtifact === true
    || payload.e2e === true
    || (typeof payload.videoName === 'string' && payload.videoName.toLowerCase().includes('e2e-'))
    || (typeof row.summary === 'string' && row.summary.toLowerCase().includes('e2e-'))
}

export function isGalleryQcFailed(row: {
  result?: Record<string, unknown> | null
}): boolean {
  const result = row.result ?? {}
  const imageQc = result.qc
  const videoQc = result.videoQc
  return (typeof imageQc === 'object' && imageQc !== null && 'pass' in imageQc && imageQc.pass === false)
    || (typeof videoQc === 'object' && videoQc !== null && 'pass' in videoQc && videoQc.pass === false)
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
    // QC-failed rows are removed by the route's null-safe cursor scan. Keeping
    // the SQL condition positive avoids hiding executed legacy rows that have
    // no `qc.pass` JSON key.
    and.push({ status: 'executed' })
  } else if (filters.state === 'review') {
    and.push({
      OR: [
        { AND: [{ status: 'executed' }, GALLERY_QC_FAILED_WHERE] },
        { status: { notIn: ['executed', ...PENDING_STATUSES, ...FAILED_STATUSES] } },
        { status: { in: FAILED_STATUSES } },
      ],
    })
  } else if (filters.state === 'qc_failed') {
    and.push({ status: 'executed' }, GALLERY_QC_FAILED_WHERE)
  } else if (filters.state === 'draft') {
    and.push({ status: { notIn: ['executed', ...PENDING_STATUSES, ...FAILED_STATUSES] } })
  } else if (filters.state === 'processing') {
    and.push({ status: { in: PENDING_STATUSES } })
  } else if (filters.state === 'failed') {
    and.push({ status: { in: FAILED_STATUSES } })
  }

  if (filters.qc === 'pass') and.push(QC_PASSED_WHERE)
  else if (filters.qc === 'fail') and.push(GALLERY_QC_FAILED_WHERE)

  return { AND: and }
}

export function mergeGalleryPage<T extends { id: string }>(fresh: T[], existing: T[]): T[] {
  const freshIds = new Set(fresh.map((item) => item.id))
  return [...fresh, ...existing.filter((item) => !freshIds.has(item.id))]
}

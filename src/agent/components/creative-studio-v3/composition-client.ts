import type {
  CreativeCompositionSummary,
  CreativeCompositionView,
} from '@/lib/creative-studio/composition-service'
import { parseFoundationCompositionView } from '@/lib/creative-studio/editor-agent'

type CompositionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type CompositionScope = {
  brandProfileId: string
  projectId: string
}

export type CreativeStudioV3CompositionClient = {
  listCompositions(scope: CompositionScope): Promise<CreativeCompositionSummary[]>
  createComposition(input: CompositionScope & {
    idempotencyKey: string
    title?: string
  }): Promise<{
    composition: CreativeCompositionView
    idempotent: boolean
  }>
  getComposition(input: CompositionScope & {
    compositionId: string
  }): Promise<CreativeCompositionView>
}

export type ResolvedStudioComposition = {
  composition: CreativeCompositionView
  source: 'existing' | 'created' | 'recovered'
  idempotencyKey: string | null
}

export class CreativeStudioV3CompositionError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, status: number, message = code) {
    super(message)
    this.name = 'CreativeStudioV3CompositionError'
    this.status = status
    this.code = code
  }
}

const COMPOSITION_API = '/api/assistant/creative-studio/compositions'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
  return value
}

function requiredInteger(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
  return value as number
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
  return value
}

function responseErrorCode(value: unknown, fallback: string): string {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const code = payload.error ?? payload.code
  return typeof code === 'string' && /^[a-z0-9_-]{2,100}$/i.test(code)
    ? code.toLowerCase()
    : fallback
}

async function requestJson(
  fetcher: CompositionFetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(input, init)
  } catch {
    throw new CreativeStudioV3CompositionError(
      'network_unavailable',
      0,
      'The Foundation composition service is offline.',
    )
  }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new CreativeStudioV3CompositionError(
      responseErrorCode(payload, 'foundation_unavailable'),
      response.status,
    )
  }
  return payload
}

function parseCompositionSummary(value: unknown): CreativeCompositionSummary {
  const row = record(value)
  const sourceKind = requiredString(row.sourceKind)
  if (sourceKind !== 'project_projection' && sourceKind !== 'native') {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
  return {
    id: requiredString(row.id),
    ownerId: requiredString(row.ownerId),
    brandProfileId: requiredString(row.brandProfileId),
    projectId: requiredString(row.projectId),
    title: requiredString(row.title),
    sourceKind,
    schemaVersion: requiredInteger(row.schemaVersion),
    currentVersion: requiredInteger(row.currentVersion),
    concurrencyToken: requiredString(row.concurrencyToken),
    readonly: requiredBoolean(row.readonly),
    createdById: requiredString(row.createdById),
    createdAt: requiredString(row.createdAt),
    updatedAt: requiredString(row.updatedAt),
  }
}

function assertScope(
  value: Pick<CreativeCompositionSummary, 'brandProfileId' | 'projectId'>,
  scope: CompositionScope,
): void {
  if (
    value.brandProfileId !== scope.brandProfileId
    || value.projectId !== scope.projectId
  ) {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
      'The Foundation response crossed the requested brand/project scope.',
    )
  }
}

function parseCompositionView(value: unknown): CreativeCompositionView {
  try {
    return parseFoundationCompositionView(value)
  } catch {
    throw new CreativeStudioV3CompositionError(
      'invalid_foundation_response',
      502,
    )
  }
}

export function createCreativeStudioV3CompositionClient(
  fetcher: CompositionFetch = (input, init) => globalThis.fetch(input, init),
): CreativeStudioV3CompositionClient {
  return {
    async listCompositions(scope) {
      const query = new URLSearchParams({
        brandProfileId: scope.brandProfileId,
        projectId: scope.projectId,
      })
      const payload = record(await requestJson(
        fetcher,
        `${COMPOSITION_API}?${query.toString()}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        },
      ))
      if (!Array.isArray(payload.compositions)) {
        throw new CreativeStudioV3CompositionError(
          'invalid_foundation_response',
          502,
        )
      }
      return payload.compositions.map((value) => {
        const summary = parseCompositionSummary(value)
        assertScope(summary, scope)
        return summary
      })
    },

    async createComposition(input) {
      const payload = record(await requestJson(fetcher, COMPOSITION_API, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: input.projectId,
          brandProfileId: input.brandProfileId,
          idempotencyKey: input.idempotencyKey,
          ...(input.title ? { title: input.title } : {}),
        }),
      }))
      const composition = parseCompositionView(payload.composition)
      assertScope(composition, input)
      if (typeof payload.idempotent !== 'boolean') {
        throw new CreativeStudioV3CompositionError(
          'invalid_foundation_response',
          502,
        )
      }
      return { composition, idempotent: payload.idempotent }
    },

    async getComposition(input) {
      const query = new URLSearchParams({
        brandProfileId: input.brandProfileId,
      })
      const payload = record(await requestJson(
        fetcher,
        `${COMPOSITION_API}/${encodeURIComponent(input.compositionId)}?${query.toString()}`,
        {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        },
      ))
      const composition = parseCompositionView(payload.composition)
      if (composition.id !== input.compositionId) {
        throw new CreativeStudioV3CompositionError(
          'invalid_foundation_response',
          502,
        )
      }
      assertScope(composition, input)
      return composition
    },
  }
}

async function deterministicCreationKey(input: {
  actorUserId: string
  brandProfileId: string
  projectId: string
}): Promise<string> {
  const payload = new TextEncoder().encode([
    'creative-studio-v3-composition',
    input.actorUserId,
    input.brandProfileId,
    input.projectId,
  ].join('\u0000'))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', payload)
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return `cs-v3-open:${hex}`
}

async function loadExistingComposition(
  client: CreativeStudioV3CompositionClient,
  scope: CompositionScope,
): Promise<CreativeCompositionView | null> {
  const compositions = await client.listCompositions(scope)
  const canonical = compositions[0]
  if (!canonical) return null
  return client.getComposition({
    ...scope,
    compositionId: canonical.id,
  })
}

function recoverableCreateError(
  error: unknown,
): error is CreativeStudioV3CompositionError {
  return error instanceof CreativeStudioV3CompositionError
    && (
      error.code === 'network_unavailable'
      || error.code === 'idempotency_conflict'
      || error.status === 409
    )
}

export async function resolveStudioProjectComposition(input: {
  actorUserId: string
  allowCreate: boolean
  brandProfileId: string
  client: CreativeStudioV3CompositionClient
  projectId: string
  projectName: string
}): Promise<ResolvedStudioComposition> {
  const scope = {
    brandProfileId: input.brandProfileId,
    projectId: input.projectId,
  }
  try {
    const existing = await loadExistingComposition(input.client, scope)
    if (existing) {
      return { composition: existing, source: 'existing', idempotencyKey: null }
    }
  } catch (error) {
    if (
      !(error instanceof CreativeStudioV3CompositionError)
      || (error.status !== 404 && error.code !== 'composition_not_found')
    ) throw error
    const refreshed = await loadExistingComposition(input.client, scope)
    if (refreshed) {
      return { composition: refreshed, source: 'recovered', idempotencyKey: null }
    }
  }

  if (!input.allowCreate) {
    throw new CreativeStudioV3CompositionError(
      'composition_creation_unavailable',
      409,
      'No accessible composition exists and Foundation creation is unavailable.',
    )
  }

  const idempotencyKey = await deterministicCreationKey(input)
  try {
    const created = await input.client.createComposition({
      ...scope,
      idempotencyKey,
      title: `${input.projectName} composition`,
    })
    return {
      composition: created.composition,
      source: created.idempotent ? 'recovered' : 'created',
      idempotencyKey,
    }
  } catch (error) {
    if (!recoverableCreateError(error)) throw error
    const recovered = await loadExistingComposition(input.client, scope)
    if (!recovered) throw error
    return { composition: recovered, source: 'recovered', idempotencyKey }
  }
}

export function creativeStudioV3CompositionErrorMessage(error: unknown): string {
  if (!(error instanceof CreativeStudioV3CompositionError)) {
    return 'The composition could not be opened. No provider or external action ran.'
  }
  const messages: Record<string, string> = {
    creative_studio_v3_foundation_disabled:
      'The Foundation read rollout is off. Legacy Studio remains available to owners.',
    creative_studio_v3_writes_disabled:
      'Foundation writes are off. An existing composition can be previewed, but a new one cannot be created.',
    composition_creation_unavailable:
      'No accessible composition exists for this project, and creation is not enabled for this role/rollout.',
    studio_draft_forbidden:
      'This Studio role can preview an existing composition but cannot create one.',
    role_forbidden:
      'The authenticated Studio role cannot create or change this composition.',
    brand_scope_mismatch:
      'The composition does not belong to the active accessible brand.',
    project_not_found:
      'The selected project is no longer accessible. Reload Projects and choose again.',
    network_unavailable:
      'The Foundation service is offline. Retry safely; the same idempotency key will be reused.',
    invalid_foundation_response:
      'The Foundation response failed its scope or version contract.',
  }
  return messages[error.code]
    ?? `The Foundation composition request was rejected (${error.code}).`
}

export const creativeStudioV3CompositionClient =
  createCreativeStudioV3CompositionClient()

import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { businessAllowed } from '@/lib/business-access'
import { normalizeAlmaRole } from '@/lib/roles'
import type { BusinessId } from '@/lib/businesses'
import {
  INTERNAL_ENTITY_REGISTRY,
  INTERNAL_SECTION_REGISTRY,
  normalizeReferenceEntityId,
  resolveEntityBusinessId,
  type InternalEntityNamespace,
} from '@/agent/lib/references/internal-registry'
import { resolveReferenceEntity } from '@/agent/lib/references/entity-resolver'
import { shouldRenderAgentReferences } from '@/agent/lib/references/flags'

export const runtime = 'nodejs'

const REFERENCE_CACHE_HEADERS = { 'Cache-Control': 'private, no-store' } as const

function referenceJson(body: unknown, status: number) {
  return Response.json(body, { status, headers: REFERENCE_CACHE_HEADERS })
}

function requestedBusiness(value: string | null): BusinessId | null | undefined {
  if (value == null) return null
  if (value === 'ALMA_LIFESTYLE' || value === 'CREATIVE_DIGITAL_IT' || value === 'ALMA_TRADING') return value
  return undefined
}

export async function GET(req: NextRequest, props: { params: Promise<{ namespace: string; id: string }> }) {
  const disabled = requireAgentEnabled()
  if (disabled) {
    disabled.headers.set('Cache-Control', REFERENCE_CACHE_HEADERS['Cache-Control'])
    return disabled
  }
  if (!shouldRenderAgentReferences()) return referenceJson({ state: 'not_found' }, 404)
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return referenceJson({ state: 'unauthorized' }, 401)
  const { namespace: rawNamespace, id: rawId } = await props.params
  if (!Object.prototype.hasOwnProperty.call(INTERNAL_ENTITY_REGISTRY, rawNamespace)) {
    return referenceJson({ state: 'not_found' }, 404)
  }
  const namespace = rawNamespace as InternalEntityNamespace
  const id = normalizeReferenceEntityId(rawId)
  if (!id) return referenceJson({ state: 'not_found' }, 404)

  const spec = INTERNAL_ENTITY_REGISTRY[namespace]
  const role = normalizeAlmaRole(token.role as string | undefined)
  if (!spec.roles.includes(role)) return referenceJson({ state: 'forbidden' }, 403)
  const rawBusiness = requestedBusiness(req.nextUrl.searchParams.get('business_id'))
  if (rawBusiness === undefined) return referenceJson({ state: 'not_found' }, 404)
  const businessId = resolveEntityBusinessId(spec, { businessId: rawBusiness ?? undefined }, rawBusiness)
  if (spec.businessIds !== 'personal' && !businessId) return referenceJson({ state: 'not_found' }, 404)
  if (businessId && !businessAllowed(token.businessAccess as string | undefined, businessId)) {
    return referenceJson({ state: 'forbidden' }, 403)
  }

  try {
    const entity = await resolveReferenceEntity({ namespace, id, businessId, userId: token.sub })
    if (!entity) return referenceJson({ state: 'not_found' }, 404)
    const fallback = INTERNAL_SECTION_REGISTRY[spec.fallbackSection]
    return referenceJson({
      state: entity.status === 'deleted' ? 'deleted' : 'found',
      entity: { ...entity, fallbackPath: fallback.webPath },
    }, entity.status === 'deleted' ? 410 : 200)
  } catch (error) {
    const failure = error as { name?: unknown; code?: unknown }
    // Do not log entity ids, URLs, database messages, tokens, or PII.
    console.error('[agent-reference] exact lookup failed', {
      namespace,
      errorName: typeof failure?.name === 'string' ? failure.name : 'unknown',
      errorCode: typeof failure?.code === 'string' ? failure.code : undefined,
    })
    return referenceJson({ state: 'error' }, 500)
  }
}

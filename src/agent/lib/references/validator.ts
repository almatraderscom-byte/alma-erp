import type { BusinessId } from '@/lib/businesses'
import type { AlmaRole } from '@/lib/roles'
import {
  buildInternalEntityReference,
  buildInternalSectionReference,
  cleanReferenceLabel,
  deterministicReferenceId,
  INTERNAL_ENTITY_REGISTRY,
  INTERNAL_SECTION_REGISTRY,
  normalizeReferenceEntityId,
  type InternalEntityNamespace,
  type InternalSectionId,
} from './internal-registry'
import {
  buildExternalReference,
  buildOwnerFileMediaReference,
  buildVerifiedMetaObjectReference,
  ownerAuthenticatedFileUrl,
  validateAndSanitizeExternalUrl,
} from './external-url'
import {
  AGENT_REFERENCE_VERSION,
  type AgentReferenceContext,
  type AgentReferenceV1,
} from './types'

const MAX_REFERENCES = 50

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validObservedAt(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function roleArray(value: unknown): AlmaRole[] | null {
  if (!Array.isArray(value)) return null
  const roles = value.filter((role): role is AlmaRole =>
    role === 'SUPER_ADMIN' || role === 'ADMIN' || role === 'HR' || role === 'STAFF' || role === 'VIEWER')
  return roles.length === value.length && roles.length > 0 ? roles : null
}

function businessId(value: unknown): BusinessId | null | undefined {
  if (value === null) return null
  if (value === 'ALMA_LIFESTYLE' || value === 'CREATIVE_DIGITAL_IT' || value === 'ALMA_TRADING') return value
  return undefined
}

function contextAllowsAudience(candidate: Record<string, unknown>, context: AgentReferenceContext): boolean {
  const audience = object(candidate.audience)
  if (!audience) return false
  const candidateBusiness = businessId(audience.businessId)
  const roles = roleArray(audience.roles)
  const scope = audience.businessScope
  if (candidateBusiness === undefined || !roles
    || (scope !== 'exact' && scope !== 'cross_business' && scope !== 'personal')) return false
  if ((scope === 'exact') !== (candidateBusiness !== null)) return false
  if ((scope === 'cross_business' || scope === 'personal') && candidateBusiness !== null) return false
  if (context.businessId && candidateBusiness && candidateBusiness !== context.businessId) return false
  if (context.roles && !context.roles.some((role) => roles.includes(role))) return false
  return true
}

/** Canonical rebuilds may narrow an audience, but must never widen the roles
 * asserted by the persisted/message-scoped reference. */
function canonicalAudienceRoles(
  candidate: Record<string, unknown>,
  context: AgentReferenceContext,
): AlmaRole[] | null {
  const candidateRoles = roleArray(object(candidate.audience)?.roles)
  if (!candidateRoles) return null
  const roles = context.roles
    ? candidateRoles.filter((role) => context.roles!.includes(role))
    : candidateRoles
  return roles.length > 0 ? roles : null
}

function canonicalInternal(candidate: Record<string, unknown>, context: AgentReferenceContext): AgentReferenceV1 | null {
  const destination = object(candidate.destination)
  const provenance = object(candidate.provenance)
  const observedAt = validObservedAt(candidate.observedAt)
  if (!destination || !provenance || !observedAt || !contextAllowsAudience(candidate, context)) return null
  const sourceTool = typeof provenance.sourceTool === 'string' ? provenance.sourceTool : undefined
  const outputPath = typeof provenance.outputPath === 'string' ? provenance.outputPath : undefined
  const label = typeof candidate.label === 'string' ? candidate.label : undefined
  const candidateBusiness = businessId(object(candidate.audience)?.businessId)
  const roles = canonicalAudienceRoles(candidate, context)
  if (!roles) return null
  const validationContext: AgentReferenceContext = {
    businessId: candidateBusiness ?? context.businessId,
    roles,
    observedAt,
  }

  if (candidate.kind === 'internal_section' && destination.type === 'internal_section') {
    const sectionId = destination.sectionId
    if (typeof sectionId !== 'string'
      || !Object.prototype.hasOwnProperty.call(INTERNAL_SECTION_REGISTRY, sectionId)) return null
    const canonical = buildInternalSectionReference(sectionId as InternalSectionId, validationContext, {
      label,
      sourceTool,
      outputPath,
    })
    if (!canonical || canonical.destination.type !== 'internal_section') return null
    if (destination.webPath !== canonical.destination.webPath || destination.nativePath !== canonical.destination.nativePath) return null
    return canonical
  }

  if (candidate.kind === 'internal_entity' && destination.type === 'internal_entity') {
    const namespace = destination.namespace
    const id = normalizeReferenceEntityId(destination.id)
    if (typeof namespace !== 'string'
      || !Object.prototype.hasOwnProperty.call(INTERNAL_ENTITY_REGISTRY, namespace)
      || !id || !sourceTool || !outputPath) return null
    const canonical = buildInternalEntityReference({
      namespace: namespace as InternalEntityNamespace,
      id,
      label,
      aliases: Array.isArray(candidate.aliases) ? candidate.aliases : [],
      rowBusinessId: candidateBusiness,
      sourceTool,
      outputPath,
      context: validationContext,
    })
    if (!canonical || canonical.destination.type !== 'internal_entity') return null
    if (
      destination.webPath !== canonical.destination.webPath
      || destination.nativePath !== canonical.destination.nativePath
      || destination.apiPath !== canonical.destination.apiPath
    ) return null
    return canonical
  }
  return null
}

function canonicalArtifact(candidate: Record<string, unknown>, context: AgentReferenceContext): AgentReferenceV1 | null {
  if (candidate.kind !== 'artifact_report' || !contextAllowsAudience(candidate, context)) return null
  const destination = object(candidate.destination)
  const provenance = object(candidate.provenance)
  const observedAt = validObservedAt(candidate.observedAt)
  const artifactId = normalizeReferenceEntityId(destination?.artifactId)
  if (!destination || destination.type !== 'artifact_report' || !artifactId || !provenance || !observedAt) return null
  const apiPath = `/api/assistant/artifacts/${encodeURIComponent(artifactId)}/doc`
  if (destination.apiPath !== apiPath && destination.apiPath !== `/api/assistant/artifacts/${encodeURIComponent(artifactId)}/pdf`) return null
  if (provenance.source !== 'tool_output' || provenance.verifiedBy !== 'explicit_extractor') return null
  const audience = object(candidate.audience)!
  const roles = canonicalAudienceRoles(candidate, context)
  if (!roles) return null
  return {
    version: AGENT_REFERENCE_VERSION,
    refId: deterministicReferenceId(['artifact', artifactId]),
    kind: 'artifact_report',
    label: cleanReferenceLabel(candidate.label, `Artifact ${artifactId}`),
    destination: {
      type: 'artifact_report',
      artifactId,
      apiPath: destination.apiPath,
      mimeType: typeof destination.mimeType === 'string' ? destination.mimeType.slice(0, 128) : undefined,
      fileName: typeof destination.fileName === 'string' ? destination.fileName.slice(0, 255) : undefined,
    },
    entity: { namespace: 'artifact', type: 'agent_artifact', id: artifactId },
    purpose: 'report',
    audience: {
      businessId: businessId(audience.businessId) ?? null,
      businessScope: 'personal',
      roles,
    },
    provenance: {
      source: 'tool_output',
      verifiedBy: 'explicit_extractor',
      sourceTool: typeof provenance.sourceTool === 'string' ? provenance.sourceTool : undefined,
      outputPath: typeof provenance.outputPath === 'string' ? provenance.outputPath : undefined,
    },
    observedAt,
    openMode: 'artifact_viewer',
    aliases: Array.isArray(candidate.aliases) ? candidate.aliases.filter((v): v is string => typeof v === 'string').slice(0, 12) : undefined,
  }
}

function canonicalExternal(candidate: Record<string, unknown>, context: AgentReferenceContext): AgentReferenceV1 | null {
  if (candidate.kind !== 'external_object' && candidate.kind !== 'external_source' && candidate.kind !== 'external_media') return null
  if (!contextAllowsAudience(candidate, context)) return null
  const destination = object(candidate.destination)
  const provenance = object(candidate.provenance)
  const observedAt = validObservedAt(candidate.observedAt)
  if (!destination || destination.type !== candidate.kind || !provenance || !observedAt) return null
  // ALMA's own authenticated file endpoint is not an external URL: its
  // `redirect=1` is the mechanism, and the external validator rightly refuses
  // that query key for third-party hosts. Narrow bypass — media references only,
  // our own host only, the exact reviewed path only (Codex P1, PR #845).
  const ownerFile = candidate.kind === 'external_media'
    ? ownerAuthenticatedFileUrl(destination.url)
    : null
  const checked = ownerFile
    ? { ok: true as const, value: { url: ownerFile.url, hostname: ownerFile.hostname, provider: 'alma' } }
    : validateAndSanitizeExternalUrl(destination.url)
  if (!checked.ok || checked.value.url !== destination.url) return null
  const source = provenance.source
  if (source !== 'tool_output' && source !== 'connector_output' && source !== 'browser_observed' && source !== 'user_provided') return null
  const entity = object(candidate.entity)
  const metaProvider = checked.value.provider === 'facebook'
    || checked.value.provider === 'instagram'
    || checked.value.provider === 'meta'
  const metaNamespace = typeof entity?.namespace === 'string' && entity.namespace.startsWith('meta_')
  if (candidate.kind === 'external_object' && (metaProvider || metaNamespace)) {
    if (!metaProvider || !metaNamespace) return null
    const id = normalizeReferenceEntityId(entity.id)
    const accountId = normalizeReferenceEntityId(entity.accountId)
    const level = entity.level
    if (!id || !accountId
      || (level !== 'campaign' && level !== 'ad_set' && level !== 'ad'
        && level !== 'creative' && level !== 'commerce_order')) return null
    const meta = buildVerifiedMetaObjectReference({
      rawUrl: checked.value.url,
      label: candidate.label,
      adAccountId: accountId,
      level,
      objectId: id,
      sourceTool: typeof provenance.sourceTool === 'string' ? provenance.sourceTool : '',
      outputPath: typeof provenance.outputPath === 'string' ? provenance.outputPath : '',
      context: {
        businessId: businessId(object(candidate.audience)?.businessId) ?? undefined,
        roles: canonicalAudienceRoles(candidate, context) ?? undefined,
        observedAt,
      },
    })
    return meta?.destination.type === candidate.kind ? meta : null
  }
  const audience = object(candidate.audience)!
  const roles = canonicalAudienceRoles(candidate, context)
  if (!roles) return null
  // Rebuilt from the reviewed internal builder, not the external one — the
  // external builder would re-run the URL gate that refuses `redirect=1`.
  if (ownerFile) {
    const owned = buildOwnerFileMediaReference({
      rawUrl: ownerFile.url,
      label: candidate.label,
      mediaType: typeof destination.mediaType === 'string' ? destination.mediaType : undefined,
      source,
      sourceTool: typeof provenance.sourceTool === 'string' ? provenance.sourceTool : undefined,
      outputPath: typeof provenance.outputPath === 'string' ? provenance.outputPath : undefined,
      context: {
        businessId: businessId(audience.businessId) ?? undefined,
        roles,
        observedAt,
      },
    })
    return owned?.destination.type === candidate.kind ? owned : null
  }
  const canonical = buildExternalReference({
    rawUrl: checked.value.url,
    label: candidate.label,
    kind: candidate.kind,
    purpose: candidate.purpose === 'media' || candidate.purpose === 'evidence' || candidate.purpose === 'navigate' ? candidate.purpose : 'source',
    source,
    sourceTool: typeof provenance.sourceTool === 'string' ? provenance.sourceTool : undefined,
    outputPath: typeof provenance.outputPath === 'string' ? provenance.outputPath : undefined,
    connector: typeof provenance.connector === 'string' ? provenance.connector : undefined,
    entity: entity && typeof entity.namespace === 'string' && typeof entity.type === 'string' && typeof entity.id === 'string'
      ? {
          namespace: entity.namespace,
          type: entity.type,
          id: entity.id,
          accountId: typeof entity.accountId === 'string' ? entity.accountId : undefined,
          level: typeof entity.level === 'string' ? entity.level : undefined,
        }
      : undefined,
    mediaType: typeof destination.mediaType === 'string' ? destination.mediaType : undefined,
    context: {
      businessId: businessId(audience.businessId) ?? undefined,
      roles,
      observedAt,
    },
  })
  return canonical?.destination.type === candidate.kind ? canonical : null
}

/** Rebuild a reference from server registries/validators; caller-authored hrefs never survive. */
export function canonicalizeAgentReference(
  value: unknown,
  context: AgentReferenceContext = {},
): AgentReferenceV1 | null {
  const candidate = object(value)
  if (!candidate || candidate.version !== AGENT_REFERENCE_VERSION) return null
  return canonicalInternal(candidate, context)
    ?? canonicalArtifact(candidate, context)
    ?? canonicalExternal(candidate, context)
}

export function mergeAgentReferences(
  ...inputs: ReadonlyArray<ReadonlyArray<unknown>>
): AgentReferenceV1[] {
  const merged: AgentReferenceV1[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    for (const raw of input) {
      const reference = canonicalizeAgentReference(raw)
      if (!reference || seen.has(reference.refId)) continue
      seen.add(reference.refId)
      merged.push(reference)
      if (merged.length >= MAX_REFERENCES) return merged
    }
  }
  return merged
}

export function filterAgentReferencesForContext(
  values: ReadonlyArray<unknown>,
  context: AgentReferenceContext,
): AgentReferenceV1[] {
  const merged: AgentReferenceV1[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const reference = canonicalizeAgentReference(raw, context)
    if (!reference || seen.has(reference.refId)) continue
    seen.add(reference.refId)
    merged.push(reference)
    if (merged.length >= MAX_REFERENCES) break
  }
  return merged
}

import type { BusinessId } from '@/lib/businesses'
import type { AlmaRole } from '@/lib/roles'

export const AGENT_REFERENCE_VERSION = 1 as const

export type AgentReferenceKind =
  | 'internal_section'
  | 'internal_entity'
  | 'external_object'
  | 'external_source'
  | 'external_media'
  | 'artifact_report'

export type AgentReferencePurpose =
  | 'navigate'
  | 'source'
  | 'evidence'
  | 'media'
  | 'report'

export type AgentReferenceOpenMode =
  | 'internal_native'
  | 'protected_web'
  | 'universal_link_first'
  | 'artifact_viewer'

export type AgentReferenceSource =
  | 'tool_output'
  | 'connector_output'
  | 'browser_observed'
  | 'user_provided'
  | 'server_registry'

export interface AgentReferenceEntityV1 {
  /** Collision-free namespace. `order` never means a Meta Commerce order. */
  namespace: string
  type: string
  id: string
  /** Required for account-scoped external objects such as Meta campaign/ad. */
  accountId?: string
  level?: string
}

export interface AgentReferenceAudienceV1 {
  businessId: BusinessId | null
  businessScope: 'exact' | 'cross_business' | 'personal'
  roles: AlmaRole[]
}

export interface AgentReferenceProvenanceV1 {
  source: AgentReferenceSource
  verifiedBy: 'server_registry' | 'explicit_extractor' | 'canonical_url_validator'
  sourceTool?: string
  outputPath?: string
  connector?: string
}

export type AgentReferenceDestinationV1 =
  | {
      type: 'internal_section'
      sectionId: string
      webPath: string
      nativePath: string
    }
  | {
      type: 'internal_entity'
      namespace: string
      id: string
      webPath: string
      nativePath: string
      apiPath: string
    }
  | {
      type: 'external_object' | 'external_source' | 'external_media'
      url: string
      provider: string
      hostname: string
      mediaType?: string
    }
  | {
      type: 'artifact_report'
      artifactId: string
      apiPath: string
      mimeType?: string
      fileName?: string
    }

/**
 * Provider-neutral verified reference contract.
 *
 * Models may quote these values, but only server code can mint/validate them.
 * The destination is intentionally a closed union so renderers never infer
 * source/action/media semantics from labels or filename extensions.
 */
export interface AgentReferenceV1 {
  version: typeof AGENT_REFERENCE_VERSION
  refId: string
  kind: AgentReferenceKind
  label: string
  destination: AgentReferenceDestinationV1
  entity?: AgentReferenceEntityV1
  purpose: AgentReferencePurpose
  audience: AgentReferenceAudienceV1
  provenance: AgentReferenceProvenanceV1
  observedAt: string
  openMode: AgentReferenceOpenMode
  aliases?: string[]
  /** Safe user-visible context; never contains tokens or full query strings. */
  display?: {
    provider?: string
    domain?: string
  }
}

/** Name used by connector/tool boundaries that want an explicitly link-shaped type. */
export type VerifiedLinkRef = AgentReferenceV1

export interface AgentReferenceContext {
  businessId?: BusinessId
  observedAt?: string
  roles?: AlmaRole[]
}

export interface ReferenceToolRecord {
  toolName: string
  output: unknown
  status?: string
  observedAt?: string
}

export const DEFAULT_REFERENCE_ROLES: AlmaRole[] = [
  'SUPER_ADMIN',
  'ADMIN',
  'HR',
  'STAFF',
  'VIEWER',
]

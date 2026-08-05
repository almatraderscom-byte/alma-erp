import type {
  EditorOperationProposal,
  OwnerPlanAcknowledgement,
} from '@/lib/creative-studio/editor-agent/contracts'

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite_fingerprint_value')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const result: { [key: string]: CanonicalValue } = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) result[key] = canonicalize(entry)
    }
    return result
  }
  throw new Error('unsupported_fingerprint_value')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('web_crypto_unavailable')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

export function proposalFingerprintPayload(
  proposal: Omit<EditorOperationProposal, 'fingerprint'> | EditorOperationProposal,
) {
  return {
    contractVersion: proposal.contractVersion,
    origin: proposal.origin,
    scope: proposal.scope,
    expectedVersion: proposal.expectedVersion,
    expectedConcurrencyToken: proposal.expectedConcurrencyToken,
    actorRoleAtPlan: proposal.actorRoleAtPlan,
    normalizedInstruction: proposal.normalizedInstruction,
    operations: proposal.operations,
    pendingActions: proposal.pendingActions,
    requiresClarification: proposal.requiresClarification,
    totalLocalCostBdt: proposal.totalLocalCostBdt,
    totalPendingCostBdt: proposal.totalPendingCostBdt,
  }
}

export async function computeProposalFingerprint(
  proposal: Omit<EditorOperationProposal, 'fingerprint'> | EditorOperationProposal,
): Promise<string> {
  const digest = await sha256Hex(stableStringify(proposalFingerprintPayload(proposal)))
  return `csplan-v1-${digest}`
}

export function shortPlanFingerprint(fingerprint: string): string {
  const digest = fingerprint.replace(/^csplan-v1-/, '')
  return digest.slice(0, 12).toUpperCase()
}

export function acknowledgementMatchesProposal(
  acknowledgement: OwnerPlanAcknowledgement | undefined,
  proposal: EditorOperationProposal,
): boolean {
  if (!acknowledgement) return false
  return (
    acknowledgement.fingerprint === proposal.fingerprint
    && acknowledgement.expectedVersion === proposal.expectedVersion
    && acknowledgement.scope.brandProfileId === proposal.scope.brandProfileId
    && acknowledgement.scope.projectId === proposal.scope.projectId
    && acknowledgement.scope.compositionId === proposal.scope.compositionId
    && acknowledgement.acknowledgedByRole === 'owner'
  )
}

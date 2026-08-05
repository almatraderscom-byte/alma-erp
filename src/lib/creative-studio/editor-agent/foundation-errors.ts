export type FoundationCompositionPortErrorCode =
  | 'network_unavailable'
  | 'invalid_foundation_response'
  | 'unsupported_foundation_mapping'
  | 'idempotency_conflict'
  | 'foundation_unavailable'

export class FoundationCompositionPortError extends Error {
  readonly code: FoundationCompositionPortErrorCode
  readonly status: number
  readonly details: Record<string, unknown> | null

  constructor(
    code: FoundationCompositionPortErrorCode,
    status = 0,
    details: Record<string, unknown> | null = null,
  ) {
    super(code)
    this.name = 'FoundationCompositionPortError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function unsupportedFoundationMapping(
  reason: string,
  details: Record<string, unknown> = {},
): never {
  throw new FoundationCompositionPortError(
    'unsupported_foundation_mapping',
    422,
    { reason, ...details },
  )
}

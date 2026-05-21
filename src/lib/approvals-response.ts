type ApprovalRow = {
  id: string
  status?: string
  [key: string]: unknown
}

export type ApprovalResponse = {
  approvals: ApprovalRow[]
  totalPending: number
  byModule: Array<{ module: string; count: number }>
  byPriority: Array<{ priority: string; count: number }>
}

type RawApprovalPayload = Partial<ApprovalResponse> & {
  approvals?: unknown
  byModule?: unknown
  byPriority?: unknown
  totalPending?: unknown
}

/** Prevents render crashes when API or stale PWA cache returns partial payloads. */
export function normalizeApprovalResponse(raw: RawApprovalPayload | null | undefined): ApprovalResponse {
  const approvals = Array.isArray(raw?.approvals) ? raw.approvals : []
  const byModule = Array.isArray(raw?.byModule) ? raw.byModule : []
  const byPriority = Array.isArray(raw?.byPriority) ? raw.byPriority : []
  const totalPending = Number.isFinite(Number(raw?.totalPending))
    ? Number(raw?.totalPending)
    : approvals.filter((row: { status?: string }) => row?.status === 'PENDING').length

  return {
    approvals: approvals as ApprovalResponse['approvals'],
    totalPending,
    byModule: byModule as ApprovalResponse['byModule'],
    byPriority: byPriority as ApprovalResponse['byPriority'],
  }
}

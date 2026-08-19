/**
 * Approved effects belong to the fresh visible progress turn, not the terminal
 * turn that originally staged the card. The staged id remains a compatibility
 * fallback when progress presence could not be created.
 */
export function approvalExecutionTurnId(
  progressTurnId: string | null | undefined,
  stagedTurnId: string | null | undefined,
): string | null {
  return progressTurnId?.trim() || stagedTurnId?.trim() || null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Adds server-owned progress identity beside the immutable staged tool input.
 * This is deliberately a shallow copy: approval payload.toolInput remains the
 * exact signed/staged value and is never rewritten with runtime metadata.
 */
export function withApprovalProgressTurn(
  payload: unknown,
  progressTurnId: string,
): Record<string, unknown> {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  return { ...source, progressTurnId: progressTurnId.trim() }
}

export function progressTurnIdFromApprovalPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  return nonEmptyString((payload as Record<string, unknown>).progressTurnId)
}

export function approvalConversationId(action: {
  conversationId?: unknown
  payload?: unknown
}): string | null {
  const direct = nonEmptyString(action.conversationId)
  if (direct) return direct
  if (!action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) return null
  return nonEmptyString((action.payload as Record<string, unknown>).conversationId)
}

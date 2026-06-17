/**
 * Shared USD display — matches agent chat per-message cost (AgentThread.tsx).
 */
export function formatMessageCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '$0.0000'
  return `$${usd.toFixed(4)}`
}

/** Muted duty cost line under office shift feedback. */
export function formatDutyCostLineBangla(usd: number, approximate = false): string {
  const tag = approximate ? ' (আনুমানিক)' : ''
  return `💸 খরচ: ~${formatMessageCostUsd(usd)}${tag}`
}

/** Confirm-card pending action TTL — enforced on approve and reject. */
export const PENDING_ACTION_EXPIRY_MS = 30 * 60 * 1000

/** Worker heartbeat considered stale after this many ms (watchdog). */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000

/** Per-session chat rate limit (web UI). */
export const ASSISTANT_CHAT_RATE_LIMIT_PER_MIN = 30

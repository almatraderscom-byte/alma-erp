/**
 * Phase 5 (autonomous heartbeat) — shared wake-up MARKER.
 *
 * When the heartbeat wakes the head inside the owner's currently-open chat (the
 * "100% Claude Code ScheduleWakeup" behavior), it seeds a `role:'user'` directive
 * so the head has something to react to. We do NOT want that directive to render
 * as a fake owner message (the owner never typed it). Instead the chat detects this
 * sentinel prefix and renders a small "ALMA woke on its own" divider in its place —
 * exactly like Claude Code's inline wake-up card — and the head's real turn follows.
 *
 * This module is intentionally dependency-free (no prisma / server imports) so the
 * server brain AND the client chat component can both import it.
 */

/** Prefix every heartbeat seed directive carries. The chat keys the divider off it. */
export const HEARTBEAT_WAKE_SENTINEL = '[স্বয়ংক্রিয় হার্টবিট'

/** True when a (user-role) message is the heartbeat's self-wake seed, not real owner text. */
export function isHeartbeatWakeText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(HEARTBEAT_WAKE_SENTINEL)
}

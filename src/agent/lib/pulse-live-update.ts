/**
 * Best-effort event-driven Business Pulse update.
 *
 * Meaningful Agent lifecycle events call this directly; the two-minute cron is
 * only reconciliation. This deliberately does not fake a background audio
 * session to animate the Robot — ActivityKit receives real state changes.
 */
import { buildPulseSnapshot } from '@/agent/lib/pulse-snapshot'
import { getLiveActivityTokens, sendPulsePush } from '@/agent/lib/live-activity-push'
import { resolveOwnerUserIds } from '@/agent/lib/native-owner-push'
import { toPulseContentState, type PulseSuccess } from '@/lib/pulse-state'

export async function pushCurrentPulseLiveActivity(opts?: {
  success?: PulseSuccess
}): Promise<void> {
  try {
    const ownerIds = await resolveOwnerUserIds()
    if (ownerIds.length === 0) return

    const [tokens, snapshot] = await Promise.all([
      getLiveActivityTokens(ownerIds),
      buildPulseSnapshot(),
    ])
    if (tokens.length === 0) return

    await sendPulsePush(
      tokens,
      toPulseContentState(snapshot, { success: opts?.success }),
    )
  } catch (err) {
    console.warn(
      '[pulse-live-update] event update failed:',
      err instanceof Error ? err.message : err,
    )
  }
}

import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildPulseSnapshot } from '@/agent/lib/pulse-snapshot'
import { toPulseContentState } from '@/lib/pulse-state'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Feed for the iOS "Business Pulse" Dynamic Panel (lock screen Live Activity +
 * Dynamic Island). Returns the authoritative PulseSnapshot — mode, headline,
 * metrics, the top three priority rows and the alert dedupe key. Owner-only
 * (same auth as /api/assistant/device-reminders).
 *
 * All priority selection lives in the shared domain layer
 * (src/agent/lib/pulse-snapshot.ts → src/lib/pulse-state.ts) so this route, the
 * push service and the native renderer can never disagree (spec §5). The
 * legacy v1/v2 keys (ordersToday, statusLine, pendingApprovals, openTasks) are
 * still present, so a native build older than this one keeps working unchanged.
 *
 * PRIVACY: the snapshot may carry a money amount on an approval row. The owner
 * chose (2026-07-16) to show amounts but let iOS redact them while the phone is
 * locked — the native side renders `valueText` with `.privacySensitive()`, so the
 * amount only appears after Face ID. No customer names, phone numbers or invoice
 * bodies are ever sent.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // Return the FLAT PulseContentState (same shape the push path sends via
  // toPulseContentState), NOT the raw nested PulseSnapshot. The native sync
  // (PulseNativeSync → ContentState) decodes flat `approvalId` / `approvalTitle`
  // / `approvalCounterparty`; returning the raw snapshot left those nil (they
  // live under `snapshot.approval`), so the island lost the অনুমোদন/বাতিল buttons
  // and showed only the "Approvals ট্যাবে" text (owner device-hit, build 77,
  // 2026-07-17). toPulseContentState keeps the legacy v1/v2 keys too, so older
  // builds are unaffected.
  const snapshot = await buildPulseSnapshot()
  return Response.json(toPulseContentState(snapshot))
}

/**
 * Phase C (phone companion) — native owner push for the AGENT.
 *
 * The ERP already has a working OneSignal pipeline (web + native APK register via
 * `OneSignal.login(userId)`, server send in `src/lib/notifications.ts`). But the
 * AGENT's owner notifications (`notify-owner.ts`) only used ntfy + Telegram — they
 * never reached the owner's installed app as a real, channelled push.
 *
 * This helper closes that gap WITHOUT modifying ERP code:
 *   • Self-contained: resolves the owner ERP user id(s) and calls OneSignal REST
 *     directly (same app / alias / `alma_alerts` channel the native app registered
 *     against), so it lights up exactly the subscriptions the APK already created.
 *   • Does NOT write to the ERP `notifications` table (no schema coupling, no
 *     misleading NotificationType, no data pollution) — purely a transport.
 *   • KV-gated (`agent_native_push_enabled`, default OFF) so the owner opts in with
 *     no redeploy, and fail-OPEN so a glitch never breaks the ntfy/Telegram path.
 *
 * Platform note: Android and iOS are both wired — the Capacitor shells register
 * via `OneSignal.login(userId)` and taps are routed in-app by the click listener
 * in `src/lib/native-push.ts` reading `data.actionUrl`.
 */
import { prisma } from '@/lib/prisma'
import { ANDROID_NOTIFICATION_CHANNEL_ID } from '@/lib/notification-sound'

/** KV flag (owner-tunable, no redeploy). Default OFF — capability is opt-in. */
export const AGENT_NATIVE_PUSH_ENABLED_KEY = 'agent_native_push_enabled'
/** Optional KV override: explicit owner ERP user id(s), comma-separated. */
export const AGENT_OWNER_USER_ID_KEY = 'agent_owner_user_id'

/** Reads the native-push kill-switch (KV). Default OFF. */
export async function isAgentNativePushEnabled(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: AGENT_NATIVE_PUSH_ENABLED_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Resolve the owner ERP user id(s) to target. The owner's native app subscription
 * is keyed by his ERP user id (OneSignal external_id). Resolution order:
 *   1. KV `agent_owner_user_id` (explicit, comma-separated) — owner override.
 *   2. OWNER_EMAIL env → matching active user.
 *   3. Earliest-created active SUPER_ADMIN (the founder/owner) — single id.
 * Returns [] when nothing resolves (caller no-ops).
 */
export async function resolveOwnerUserIds(): Promise<string[]> {
  // 1) Explicit KV override.
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: AGENT_OWNER_USER_ID_KEY },
      select: { value: true },
    })
    const ids = (row?.value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) return ids
  } catch {
    // fall through
  }

  // 2) OWNER_EMAIL env.
  try {
    const email = (process.env.OWNER_EMAIL ?? '').trim().toLowerCase()
    if (email) {
      const u = await prisma.user.findFirst({
        where: { email, active: true },
        select: { id: true },
      })
      if (u?.id) return [u.id]
    }
  } catch {
    // fall through
  }

  // 3) Earliest active SUPER_ADMIN.
  try {
    const u = await prisma.user.findFirst({
      where: { active: true, role: 'SUPER_ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (u?.id) return [u.id]
  } catch {
    // fall through
  }

  return []
}

/** OneSignal dashboard channel UUID vs native Android channel id (mirrors ERP). */
function resolveAndroidChannelFields(channelId?: string | null): Record<string, string> {
  const id = channelId?.trim()
  // Only honor a dashboard UUID override; any non-UUID env (e.g. a stale
  // "alma_alerts") is superseded by the current native channel constant so the
  // custom-sound fix works without editing Vercel env.
  if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { android_channel_id: id }
  }
  return { existing_android_channel_id: ANDROID_NOTIFICATION_CHANNEL_ID }
}

function absoluteUrl(path?: string | null): string | undefined {
  const raw = (path ?? '').trim()
  if (!raw) return undefined
  if (/^https?:\/\//i.test(raw)) return raw
  const base = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '')
  if (!base) return undefined
  return `${base}${raw.startsWith('/') ? '' : '/'}${raw}`
}

export interface NativePushResult {
  /** false when disabled / no owner id / OneSignal not configured — a clean no-op. */
  attempted: boolean
  ok: boolean
  reason?: string
}

/**
 * Send a native OneSignal push to the owner's app. Gated, fail-open. Never throws.
 * Mirrors the minimal subset of the ERP send payload (alias targeting, alma_alerts
 * channel, in-app tap routing via data.actionUrl) so it behaves identically on the
 * device but carries no ERP-notification-table side effects.
 */
export async function pushNativeToOwner(opts: {
  tier: 1 | 2 | 3
  title: string
  message: string
  category?: 'salah' | 'urgent' | 'task' | 'report'
  actionUrl?: string | null
}): Promise<NativePushResult> {
  try {
    if (!(await isAgentNativePushEnabled())) {
      return { attempted: false, ok: false, reason: 'disabled' }
    }

    const appId = process.env.ONESIGNAL_APP_ID || process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID
    const apiKey = process.env.ONESIGNAL_REST_API_KEY
    if (!appId || !apiKey) return { attempted: false, ok: false, reason: 'onesignal_unconfigured' }

    const userIds = await resolveOwnerUserIds()
    if (!userIds.length) return { attempted: false, ok: false, reason: 'no_owner_user_id' }

    const usesV2Key = apiKey.startsWith('os_v2_')
    // Every agent push must land SOMEWHERE on tap. Callers that don't name a
    // page fall back to the agent chat — without this the native click listener
    // gets data.actionUrl=null, does nothing, and the tap dumps the owner on
    // whatever screen the app opens to (the dashboard).
    const url = absoluteUrl(opts.actionUrl) ?? absoluteUrl('/agent')
    // tier 1 = routine, 2 = important, 3 = emergency → OneSignal priority 5/10.
    const priority = opts.tier >= 2 ? 10 : 5

    const payload: Record<string, unknown> = {
      app_id: appId,
      target_channel: 'push',
      headings: { en: opts.title },
      contents: { en: opts.message },
      web_url: url,
      priority,
      ...resolveAndroidChannelFields(process.env.ONESIGNAL_ANDROID_CHANNEL_ID),
      android_visibility: 1, // PUBLIC — show on lock screen
      android_led_color: 'FFC9A84C', // gold LED (matches ERP)
      // iOS (APNs): bump the app icon badge on each push. Custom ios_sound is left
      // default — a matching .caf/.wav must be added to the Xcode bundle before we can set it.
      ios_badgeType: 'Increase',
      ios_badgeCount: 1,
      small_icon: 'ic_stat_onesignal_default',
      data: {
        source: 'agent',
        tier: opts.tier,
        category: opts.category ?? null,
        // Native tap routing reads data.actionUrl (see native-push.ts click listener).
        actionUrl: url ?? null,
      },
    }

    if (usesV2Key) {
      payload.include_aliases = { external_id: userIds }
    } else {
      payload.include_external_user_ids = userIds
    }

    const res = await fetch(
      usesV2Key
        ? 'https://api.onesignal.com/notifications?c=push'
        : 'https://onesignal.com/api/v1/notifications',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${usesV2Key ? 'Key' : 'Basic'} ${apiKey}`,
        },
        body: JSON.stringify(payload),
      },
    )

    const raw = await res.text().catch(() => '')
    if (!res.ok) {
      return { attempted: true, ok: false, reason: `http_${res.status}: ${raw.slice(0, 200)}` }
    }
    let body: { id?: string; errors?: unknown } = {}
    try {
      body = JSON.parse(raw) as typeof body
    } catch {
      return { attempted: true, ok: false, reason: 'unparseable_response' }
    }
    // A returned notification id means OneSignal accepted at least one recipient.
    return { attempted: true, ok: Boolean(body.id), reason: body.id ? undefined : 'no_recipients' }
  } catch (err) {
    return { attempted: true, ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Feature C — Quiet-hours / DND + morning digest ("রাতে spam বন্ধ, সকালে এক brief").
 *
 * The owner shouldn't get pinged for routine things at 2am. Every owner push flows
 * through notifyOwner() — the single choke point — so this module gates it: during
 * quiet hours (night, default 22:00–08:00 Asia/Dhaka) routine pings are HELD in a
 * queue instead of sent, and the next morning the day-shift delivers ONE consolidated
 * digest of everything that was held.
 *
 * What still pierces the quiet (deliberate safety — DND silences spam, not emergencies):
 *   • tier-3 alerts (genuine critical: worker down, money/critical escalation L2).
 *   • category 'salah' (prayer reminders are time-critical, incl. Fajr before dawn).
 *
 * Owner-tunable via agent_kv_settings (no redeploy):
 *   • dnd_enabled        — 'true' (default) | 'false' (always send, no quiet hours).
 *   • dnd_window_dhaka   — 'START-END' 24h Dhaka hours, default '22-8' (overnight).
 *
 * KV-only, no migration. The held queue lives in `dnd_held_queue`.
 */
import { prisma } from '@/lib/prisma'
import { notifyOwner } from '@/agent/lib/notify-owner'

export const DND_ENABLED_KEY = 'dnd_enabled'
export const DND_WINDOW_KEY = 'dnd_window_dhaka'
export const DND_QUEUE_KEY = 'dnd_held_queue'
export const DEFAULT_DND_WINDOW = '22-8'
/** Cap the held queue so an unattended night can't grow it unbounded. */
const MAX_HELD = 50

export interface QuietHoursConfig {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface HeldNotification {
  tier: 1 | 2 | 3
  title: string
  message: string
  category?: string
  actionUrl?: string | null
  heldAt: string
}

function parseWindow(value: string | null | undefined): { startHour: number; endHour: number } {
  const v = (value ?? '').trim() || DEFAULT_DND_WINDOW
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v)
  if (!m) return { startHour: 22, endHour: 8 }
  const startHour = Math.min(23, Math.max(0, parseInt(m[1], 10)))
  const endHour = Math.min(23, Math.max(0, parseInt(m[2], 10)))
  return { startHour, endHour }
}

export async function getQuietHoursConfig(): Promise<QuietHoursConfig> {
  const [enabledRow, windowRow] = await Promise.all([
    prisma.agentKvSetting.findUnique({ where: { key: DND_ENABLED_KEY }, select: { value: true } }),
    prisma.agentKvSetting.findUnique({ where: { key: DND_WINDOW_KEY }, select: { value: true } }),
  ])
  const enabled = (enabledRow?.value ?? 'true').trim().toLowerCase() !== 'false'
  const { startHour, endHour } = parseWindow(windowRow?.value)
  return { enabled, startHour, endHour }
}

/**
 * Current hour (0–23) in Asia/Dhaka. Plain UTC arithmetic — Dhaka is a fixed
 * UTC+6 with no DST, so this cannot drift with the runtime's ICU/locale/TZ
 * state. (The previous Intl.DateTimeFormat version produced a server-local
 * hour on the deployed hnd1 runtime, firing the quiet gate hours early.)
 */
export function dhakaHour(now: Date = new Date()): number {
  return (now.getUTCHours() + 6) % 24
}

/** 'HH:MM' Dhaka wall-clock for display, same Intl-free arithmetic. */
export function dhakaTimeHHMM(now: Date): string {
  const h = String((now.getUTCHours() + 6) % 24).padStart(2, '0')
  const m = String(now.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * PURE — is `now` inside the quiet window? Handles the common OVERNIGHT case where
 * start > end (e.g. 22→8 spans midnight): quiet when hour ≥ start OR hour < end.
 */
export function isQuietHoursDhaka(now: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) return false
  const h = dhakaHour(now)
  const { startHour, endHour } = config
  if (startHour === endHour) return false // empty/degenerate window → never quiet
  return startHour > endHour ? h >= startHour || h < endHour : h >= startHour && h < endHour
}

/** A push should be held (not sent now) when it's routine AND we're in quiet hours. */
export function shouldHold(tier: number, category: string | undefined, quiet: boolean): boolean {
  if (!quiet) return false
  if (tier >= 3) return false // genuine emergency pierces DND
  if (category === 'salah') return false // prayer reminders are time-critical
  return true
}

async function readQueue(): Promise<HeldNotification[]> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key: DND_QUEUE_KEY }, select: { value: true } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? (parsed as HeldNotification[]) : []
  } catch {
    return []
  }
}

async function writeQueue(items: HeldNotification[]): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: DND_QUEUE_KEY },
    create: { key: DND_QUEUE_KEY, value: JSON.stringify(items) },
    update: { value: JSON.stringify(items) },
  })
}

/**
 * Gate for notifyOwner(): if quiet hours apply and the push is routine, queue it for
 * the morning digest and return true (caller then skips the live send). Otherwise
 * false (caller sends normally). Fail-OPEN — any error returns false so a glitch
 * never silently swallows a notification.
 */
export async function maybeHoldForQuietHours(opts: {
  tier: 1 | 2 | 3
  title: string
  message: string
  category?: string
  actionUrl?: string | null
}): Promise<boolean> {
  try {
    const config = await getQuietHoursConfig()
    const quiet = isQuietHoursDhaka(new Date(), config)
    if (!shouldHold(opts.tier, opts.category, quiet)) return false
    const queue = await readQueue()
    queue.push({
      tier: opts.tier,
      title: opts.title,
      message: opts.message,
      category: opts.category,
      actionUrl: opts.actionUrl ?? null,
      heldAt: new Date().toISOString(),
    })
    // Keep only the most recent MAX_HELD (drop oldest if it overflows).
    await writeQueue(queue.slice(-MAX_HELD))
    return true
  } catch {
    return false
  }
}

/** Read-only snapshot for the owner-facing check tool. */
export async function quietHoursStatus(now: Date = new Date()): Promise<{
  enabled: boolean
  windowDhaka: string
  isQuietNow: boolean
  heldCount: number
  heldPreview: string[]
}> {
  const config = await getQuietHoursConfig()
  const queue = await readQueue()
  return {
    enabled: config.enabled,
    windowDhaka: `${config.startHour}:00–${config.endHour}:00`,
    isQuietNow: isQuietHoursDhaka(now, config),
    heldCount: queue.length,
    heldPreview: queue.slice(-5).map((h) => h.title),
  }
}

/**
 * Morning flush — called once at day-start. If anything was held overnight, send ONE
 * consolidated digest (bypassing the quiet gate, since it's now daytime) and clear the
 * queue. Returns how many items were delivered.
 */
export async function flushQuietHoursQueue(): Promise<{ flushed: number }> {
  const queue = await readQueue()
  if (queue.length === 0) return { flushed: 0 }

  const lines = queue
    .map((h) => {
      const t = dhakaTimeHHMM(new Date(h.heldAt))
      return `• (${t}) ${h.title} — ${h.message}`
    })
    .join('\n')

  const message =
    `🌙 শুভ সকাল Boss। রাতে ${queue.length}টি আপডেট জমা রেখেছিলাম যেন আপনার ঘুম নষ্ট না হয় — ` +
    `এক জায়গায় দিলাম:\n${lines}\n\n` +
    `জরুরি কিছু থাকলে রাতেই সরাসরি জানাতাম; এগুলো অপেক্ষা করার মতো ছিল।`

  // The digest merges many held items; if exactly one page dominates use it,
  // otherwise land the tap on the agent chat where the digest text lives.
  const heldUrls = [...new Set(queue.map((h) => h.actionUrl).filter(Boolean))]
  await notifyOwner({
    tier: 1,
    title: '🌙 রাতের জমা আপডেট',
    message,
    category: 'report',
    actionUrl: heldUrls.length === 1 ? heldUrls[0] : '/agent',
    // Internal: this IS the morning delivery — don't re-hold it.
    _bypassQuietHours: true,
  }).catch(() => {})

  await writeQueue([])
  return { flushed: queue.length }
}

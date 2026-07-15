/**
 * "Business Pulse" Dynamic Panel — the web → native driver.
 *
 * A local Capacitor plugin (registered natively — NO npm package) is exposed at
 * runtime as window.Capacitor.Plugins.LiveActivityBridge with:
 *   - update({ title, snapshotJson, alert?, …legacy scalars }) → Promise
 *   - markOffline()                                            → Promise
 *   - end()                                                    → Promise
 *
 * `syncLivePulse()` fetches the authoritative snapshot from
 * /api/assistant/live-pulse and pushes it into the Live Activity so it shows on
 * the lock screen + Dynamic Island. Native iOS only, and fully fail-open: ANY
 * error is swallowed so this can never affect the app. The plugin is
 * feature-detected — if the running binary doesn't register it, we return.
 *
 * SOUND POLICY (spec §11): ordinary count/progress updates are ALWAYS silent.
 * We ask for an alert only when the snapshot carries a NEW approval/urgent
 * event key we have not alerted on before, and never on the first sync after
 * launch (that is reconciliation — spec §14: "Do not replay notification sound
 * during reconciliation"). With remote push configured the server is normally
 * the one that alerts; this client path only covers the app-in-foreground case,
 * and the shared dedupe key stops the two from double-chiming.
 */
import { isCapacitorNative } from '@/lib/capacitor-native'
import {
  clampCount,
  toPulseContentState,
  type PulseSnapshot,
  type PulseSuccess,
} from '@/lib/pulse-state'

/**
 * Native builds below this number ship WITHOUT the LiveActivityBridge plugin — on
 * those, the plugin is simply absent (we feature-detect below) but we also gate on
 * the build number first, mirroring the local-reminders safety pattern, so we
 * never even look for a plugin an old binary can't have.
 */
const MIN_NATIVE_BUILD = 8

interface LiveActivityBridgePlugin {
  update: (data: {
    title: string
    /** The canonical PulseContentState as JSON — the v3 contract. */
    snapshotJson: string
    /** Ask iOS to alert (sound + banner) for this update. Default false. */
    alert?: boolean
    alertTitle?: string
    alertBody?: string
    /** 'approval' | 'urgent' — picks the bundled .caf sound. */
    alertKind?: string
    // Legacy v1/v2 scalars — kept so the contract is unchanged for any code
    // path (or older plugin build) that still reads only these.
    ordersToday: number
    statusLine: string
    pendingApprovals: number
    openTasks: number
  }) => Promise<unknown>
  markOffline?: () => Promise<unknown>
  end: () => Promise<unknown>
}

/** Native build number, or null if it can't be read. */
async function nativeBuildNumber(): Promise<number | null> {
  try {
    const { App } = await import('@capacitor/app')
    const info = await App.getInfo()
    const build = parseInt(String(info?.build ?? ''), 10)
    return Number.isFinite(build) ? build : null
  } catch {
    return null
  }
}

/** The runtime-registered plugin, or undefined if this binary doesn't expose it. */
function getBridge(): LiveActivityBridgePlugin | undefined {
  const plugins = (window as any)?.Capacitor?.Plugins
  const bridge = plugins?.LiveActivityBridge
  if (bridge && typeof bridge.update === 'function' && typeof bridge.end === 'function') {
    return bridge as LiveActivityBridgePlugin
  }
  return undefined
}

// --- alert dedupe (spec §11.5) --------------------------------------------

const SEEN_KEY = 'alma.pulse.alertedKeys'
/** Set once the first sync of this app launch has run (that one is silent). */
let reconciled = false

function loadSeen(): Set<string> {
  try {
    const raw = window.localStorage?.getItem(SEEN_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function rememberSeen(key: string): void {
  try {
    const seen = loadSeen()
    seen.add(key)
    // Keep the list bounded — only the most recent keys matter for dedupe.
    const trimmed = [...seen].slice(-50)
    window.localStorage?.setItem(SEEN_KEY, JSON.stringify(trimmed))
  } catch {
    /* dedupe memory is best-effort; worst case we stay silent, never noisy */
  }
}

/**
 * Should this snapshot alert? Only for a brand-new event key, and never during
 * the launch reconciliation pass.
 */
function shouldAlert(alertKey: string | undefined, isReconciliation: boolean): boolean {
  if (!alertKey) return false
  const seen = loadSeen()
  if (seen.has(alertKey)) return false
  if (isReconciliation) {
    // Silent, but remember it so we don't chime for it on the next poll either.
    rememberSeen(alertKey)
    return false
  }
  return true
}

/**
 * Accept an old/degraded server payload. If the API predates v3 (no `mode`), we
 * synthesise a minimal overview snapshot from the legacy scalars rather than
 * rendering an empty panel.
 */
function normalizeSnapshot(data: Partial<PulseSnapshot>): PulseSnapshot {
  const now = new Date().toISOString()
  if (typeof data?.mode === 'string' && Array.isArray(data?.items)) return data as PulseSnapshot

  const ordersToday = clampCount(data?.ordersToday)
  const pendingApprovals = clampCount(data?.pendingApprovals)
  const openTasks = clampCount(data?.openTasks)
  return {
    mode: 'overview',
    headline: 'ব্যবসা স্বাভাবিক চলছে',
    subtitle: typeof data?.statusLine === 'string' ? data.statusLine : '',
    pendingTaskCount: openTasks,
    approvalCount: pendingApprovals,
    runningOrderCount: 0,
    items: [],
    lastUpdatedAt: now,
    staleAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
    ordersToday,
    statusLine: typeof data?.statusLine === 'string' ? data.statusLine : '',
    pendingApprovals,
    openTasks,
  }
}

/**
 * Push the current business pulse into the iOS Live Activity. Native-only,
 * build-gated, fail-open. Safe to call repeatedly (e.g. on app open + resume).
 */
export async function syncLivePulse(): Promise<void> {
  try {
    if (!isCapacitorNative()) return

    // Hard safety: never touch the plugin on a binary that predates it.
    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return

    const bridge = getBridge()
    if (!bridge) return

    let res: Response
    try {
      res = await fetch('/api/assistant/live-pulse', { credentials: 'same-origin' })
    } catch {
      // The network is down — say so honestly rather than leaving a stale
      // count looking current (spec §2 rule 9, §6.7).
      await bridge.markOffline?.()
      return
    }
    if (!res.ok) return

    const snapshot = normalizeSnapshot((await res.json()) as Partial<PulseSnapshot>)
    const isReconciliation = !reconciled
    reconciled = true

    const alert = shouldAlert(snapshot.alertKey, isReconciliation)
    if (alert && snapshot.alertKey) rememberSeen(snapshot.alertKey)

    await bridge.update({
      title: 'ALMA ERP',
      snapshotJson: JSON.stringify(toPulseContentState(snapshot)),
      alert,
      alertTitle: alert ? snapshot.headline : undefined,
      alertBody: alert ? snapshot.subtitle : undefined,
      alertKind: alert ? (snapshot.mode === 'urgent' ? 'urgent' : 'approval') : undefined,
      ordersToday: snapshot.ordersToday,
      statusLine: snapshot.statusLine,
      pendingApprovals: snapshot.approvalCount,
      openTasks: snapshot.pendingTaskCount,
    })
  } catch {
    /* the Live Activity is a nice-to-have — never let a failure surface */
  }
}

/** The standard success copy after an approval the server confirmed. */
export function approvalSuccess(): PulseSuccess {
  return {
    title: 'অনুমোদন হয়েছে',
    detail: 'কাজ আবার এগোচ্ছে',
    completedAt: new Date().toISOString(),
  }
}

/**
 * Show the temporary success state after a CONFIRMED server action (spec §6.6),
 * then let the next sync fall back to the authoritative live state. Never call
 * this straight after a tap — only once the server has confirmed.
 */
export async function showPulseSuccess(success: PulseSuccess): Promise<void> {
  try {
    if (!isCapacitorNative()) return
    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return
    const bridge = getBridge()
    if (!bridge) return

    const res = await fetch('/api/assistant/live-pulse', { credentials: 'same-origin' })
    if (!res.ok) return
    const snapshot = normalizeSnapshot((await res.json()) as Partial<PulseSnapshot>)

    // Success is always silent (spec §11.1) — the foreground haptic is the
    // confirmation, fired natively.
    await bridge.update({
      title: 'ALMA ERP',
      snapshotJson: JSON.stringify(toPulseContentState(snapshot, { success })),
      alert: false,
      ordersToday: snapshot.ordersToday,
      statusLine: snapshot.statusLine,
      pendingApprovals: snapshot.approvalCount,
      openTasks: snapshot.pendingTaskCount,
    })
  } catch {
    /* fail-open */
  }
}

/**
 * End the current Live Activity (e.g. at day rollover or sign-out). Native-only,
 * build-gated, fail-open.
 */
export async function endLivePulse(): Promise<void> {
  try {
    if (!isCapacitorNative()) return

    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return

    const bridge = getBridge()
    if (!bridge) return

    await bridge.end()
  } catch {
    /* fail-open */
  }
}

/**
 * "Business Pulse" Live Activity for the native iOS shell.
 *
 * A local Capacitor plugin (registered natively — NO npm package) is exposed at
 * runtime as window.Capacitor.Plugins.LiveActivityBridge with:
 *   - update({ title, ordersToday, statusLine, pendingApprovals, openTasks }) → Promise
 *   - end()                                                                    → Promise
 *
 * `syncLivePulse()` fetches today's pulse from /api/assistant/live-pulse
 * and pushes it into the Live Activity so it shows on the lock screen + Dynamic
 * Island. Native iOS only, and fully fail-open: ANY error is swallowed so this can
 * never affect the app. The plugin is feature-detected — if the running binary
 * doesn't register it, we simply return.
 */
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Native builds below this number ship WITHOUT the LiveActivityBridge plugin — on
 * those, the plugin is simply absent (we feature-detect below) but we also gate on
 * the build number first, mirroring the local-reminders safety pattern, so we
 * never even look for a plugin an old binary can't have.
 */
const MIN_NATIVE_BUILD = 8

interface LivePulseData {
  ordersToday: number
  statusLine: string
  /** Approvals awaiting the owner's decision (hub counter). */
  pendingApprovals: number
  /** Open agent tasks — the "বাকি কাজ" chips (hub counter). */
  openTasks: number
}

interface LiveActivityBridgePlugin {
  update: (data: {
    title: string
    ordersToday: number
    statusLine: string
    // Hub counters — old native binaries simply ignore unknown keys in the
    // plugin call, so passing them is always safe.
    pendingApprovals: number
    openTasks: number
  }) => Promise<unknown>
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

/**
 * Push today's order pulse into the iOS Live Activity. Native-only, build-gated,
 * fail-open. Safe to call repeatedly (e.g. on app open + resume).
 */
export async function syncLivePulse(): Promise<void> {
  try {
    if (!isCapacitorNative()) return

    // Hard safety: never touch the plugin on a binary that predates it.
    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return

    const bridge = getBridge()
    if (!bridge) return

    const res = await fetch('/api/assistant/live-pulse', { credentials: 'same-origin' })
    if (!res.ok) return
    const data = (await res.json()) as Partial<LivePulseData>
    const ordersToday = typeof data?.ordersToday === 'number' ? data.ordersToday : 0
    const statusLine = typeof data?.statusLine === 'string' ? data.statusLine : ''
    const pendingApprovals = typeof data?.pendingApprovals === 'number' ? data.pendingApprovals : 0
    const openTasks = typeof data?.openTasks === 'number' ? data.openTasks : 0

    await bridge.update({ title: 'ALMA ERP', ordersToday, statusLine, pendingApprovals, openTasks })
  } catch {
    /* the Live Activity is a nice-to-have — never let a failure surface */
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

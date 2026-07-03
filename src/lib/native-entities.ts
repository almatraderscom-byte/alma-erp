/**
 * App Intents entity cache sync for the native iOS shell (Phase N3).
 *
 * A local Capacitor plugin (registered natively — NO npm package) is exposed at
 * runtime as window.Capacitor.Plugins.EntityCacheBridge with:
 *   - setEntities({ orders, products }) → { saved }
 *
 * The native App Intents entity queries can't read the web session, so
 * `syncNativeEntities()` fetches the owner's recent orders from
 * /api/assistant/native-entities and pushes them into the shared App Group cache
 * via the bridge. Siri / Spotlight / Shortcuts then surface them as OrderEntity.
 *
 * Native-only, build-gated (≥ MIN_NATIVE_BUILD), fully fail-open: ANY error is
 * swallowed. The plugin is feature-detected — an old binary that lacks it is a
 * no-op.
 */
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Native builds below this number ship WITHOUT the EntityCacheBridge plugin AND
 * without the App Group entitlement — so we gate on the build number first and
 * never probe a plugin an older binary can't have (mirrors live-pulse pattern).
 */
const MIN_NATIVE_BUILD = 11

interface EntityRow {
  id: string
  title: string
  status?: string
}

interface EntityCacheBridgePlugin {
  setEntities: (opts: { orders: EntityRow[]; products: EntityRow[] }) => Promise<unknown>
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
function getBridge(): EntityCacheBridgePlugin | undefined {
  const plugins = (window as any)?.Capacitor?.Plugins
  const bridge = plugins?.EntityCacheBridge
  if (bridge && typeof bridge.setEntities === 'function') {
    return bridge as EntityCacheBridgePlugin
  }
  return undefined
}

/**
 * Push the owner's recent orders into the iOS App Intents entity cache. Native-only,
 * build-gated, fail-open. Safe to call repeatedly (e.g. on app open + resume).
 */
export async function syncNativeEntities(): Promise<void> {
  try {
    if (!isCapacitorNative()) return

    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return

    const bridge = getBridge()
    if (!bridge) return

    const res = await fetch('/api/assistant/native-entities', { credentials: 'same-origin' })
    if (!res.ok) return
    const data = (await res.json()) as { orders?: EntityRow[]; products?: EntityRow[] }
    const orders = Array.isArray(data?.orders) ? data.orders : []
    const products = Array.isArray(data?.products) ? data.products : []

    await bridge.setEntities({ orders, products })
  } catch {
    /* entity cache is a nice-to-have — never let a failure surface */
  }
}

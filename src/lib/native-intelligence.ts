/**
 * On-device intelligence bridge for the native iOS shell (Foundation Models).
 *
 * A local Capacitor plugin (registered natively — NO npm package) is exposed at
 * runtime as window.Capacitor.Plugins.NativeIntelligenceBridge with:
 *   - availability()                → { available, reason }
 *   - summarize({ text, maxWords }) → { summary, onDevice }
 *   - classify({ text, labels })    → { label, onDevice }
 *
 * The point of Phase N1 is a *zero-cost, offline* fast-path: when Apple's on-device
 * model is available it runs summarize/classify for free with no server LLM
 * round-trip; whenever it is NOT available (below iOS 26, non-native, unsupported
 * hardware, model-not-ready, old binary) we transparently fall back to the caller's
 * existing server path.
 *
 * The contract is therefore fallback-first: callers pass their current server call
 * as `serverFallback`, and this module only short-circuits to on-device when it is
 * confident. It is fully fail-open — ANY native error swallows to the server path,
 * so this can never break or block a feature.
 *
 * ⚠️ Bangla quality of the on-device model is UNVERIFIED (owner must A/B-test on his
 * iPhone before this is wired to any customer-facing / Bangla output). Until then,
 * prefer wiring it to owner-facing English summaries and classification only.
 */
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Native builds below this number ship WITHOUT the NativeIntelligenceBridge plugin.
 * The web code deploys to every existing install instantly, so — mirroring the
 * live-pulse / local-reminders safety pattern — we gate on the build number FIRST
 * and never even look for a plugin an older binary cannot have.
 */
const MIN_NATIVE_BUILD = 9

interface NativeIntelligenceBridgePlugin {
  availability: () => Promise<{ available?: boolean; reason?: string }>
  summarize: (opts: { text: string; maxWords: number }) => Promise<{
    summary?: string
    onDevice?: boolean
    reason?: string
  }>
  classify: (opts: { text: string; labels: string[] }) => Promise<{
    label?: string
    onDevice?: boolean
    reason?: string
  }>
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
function getBridge(): NativeIntelligenceBridgePlugin | undefined {
  const plugins = (window as any)?.Capacitor?.Plugins
  const bridge = plugins?.NativeIntelligenceBridge
  if (
    bridge &&
    typeof bridge.availability === 'function' &&
    typeof bridge.summarize === 'function' &&
    typeof bridge.classify === 'function'
  ) {
    return bridge as NativeIntelligenceBridgePlugin
  }
  return undefined
}

/**
 * Resolve the usable on-device bridge, or null if on-device intelligence can't be
 * used right now (non-native, old binary, plugin absent, or model unavailable).
 * Fully fail-open.
 */
async function resolveBridge(): Promise<NativeIntelligenceBridgePlugin | null> {
  try {
    if (!isCapacitorNative()) return null

    // Hard safety: never touch the plugin on a binary that predates it.
    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return null

    const bridge = getBridge()
    if (!bridge) return null

    const status = await bridge.availability()
    if (!status?.available) return null

    return bridge
  } catch {
    return null
  }
}

/**
 * Is Apple's on-device model usable right now? Native-only, build-gated, fail-open.
 * Useful for UI (e.g. an "on-device" badge) — but callers should still prefer the
 * `serverFallback`-carrying helpers below so a mid-flight failure is handled.
 */
export async function nativeIntelligenceAvailable(): Promise<boolean> {
  return (await resolveBridge()) !== null
}

/**
 * Summarize `text` to roughly `maxWords` words. Runs on-device for free when
 * available; otherwise (and on ANY failure) calls `serverFallback` and returns its
 * result. `onDevice` tells the caller which path produced the summary.
 */
export async function summarizeText(
  text: string,
  opts: { maxWords?: number; serverFallback: () => Promise<string> },
): Promise<{ summary: string; onDevice: boolean }> {
  const maxWords = opts.maxWords ?? 40
  try {
    const bridge = await resolveBridge()
    if (bridge) {
      const res = await bridge.summarize({ text, maxWords })
      const summary = typeof res?.summary === 'string' ? res.summary.trim() : ''
      if (res?.onDevice && summary) {
        return { summary, onDevice: true }
      }
    }
  } catch {
    /* fall through to the server path */
  }
  return { summary: await opts.serverFallback(), onDevice: false }
}

/**
 * Classify `text` into one of `labels`. Runs on-device for free when available;
 * otherwise (and on ANY failure, or if the model returns an off-list label) calls
 * `serverFallback` and returns its result. The returned label from the on-device
 * path is guaranteed to be one of `labels` (the native side validates it).
 */
export async function classifyText(
  text: string,
  labels: string[],
  opts: { serverFallback: () => Promise<string> },
): Promise<{ label: string; onDevice: boolean }> {
  try {
    if (labels.length > 0) {
      const bridge = await resolveBridge()
      if (bridge) {
        const res = await bridge.classify({ text, labels })
        const label = typeof res?.label === 'string' ? res.label.trim() : ''
        if (res?.onDevice && label && labels.includes(label)) {
          return { label, onDevice: true }
        }
      }
    }
  } catch {
    /* fall through to the server path */
  }
  return { label: await opts.serverFallback(), onDevice: false }
}

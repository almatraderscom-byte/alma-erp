/**
 * On-device speech-to-text bridge for the native iOS shell.
 *
 * A local Capacitor plugin (registered natively — NO npm package) is exposed at
 * runtime as window.Capacitor.Plugins.NativeSpeechBridge with:
 *   - availability({ locale })            → { available, ... }
 *   - transcribe({ audioBase64, locale }) → { text, onDevice }
 *
 * The point of Phase N2 is to transcribe dictation ON-DEVICE for free + offline
 * (Apple's on-device recognizer) instead of the Whisper API, cutting cost. It is
 * gated THREE ways so it can never regress the current voice flow:
 *   1. native + build ≥ MIN_NATIVE_BUILD (old binaries lack the plugin),
 *   2. an owner opt-in flag `alma_native_stt` in localStorage (DEFAULT OFF — the
 *      owner A/B-tests on-device Bangla accuracy vs Whisper before enabling), and
 *   3. the plugin's own availability() probe.
 *
 * Fully fail-open: if on-device STT is off / unavailable / returns nothing, the
 * caller keeps using the existing /api/assistant/transcribe (Whisper) path.
 */
import { isCapacitorNative } from '@/lib/capacitor-native'

/**
 * Native builds below this number ship WITHOUT the NativeSpeechBridge plugin. The
 * web code deploys to every existing install instantly, so — mirroring the
 * live-pulse / native-intelligence safety pattern — we gate on the build number
 * FIRST and never probe a plugin an older binary can't have.
 */
const MIN_NATIVE_BUILD = 10

/** localStorage flag: on-device STT is opt-in until the owner verifies Bangla accuracy. */
const NATIVE_STT_FLAG = 'alma_native_stt'

interface NativeSpeechBridgePlugin {
  availability: (opts: { locale: string }) => Promise<{ available?: boolean }>
  transcribe: (opts: { audioBase64: string; locale: string }) => Promise<{
    text?: string
    onDevice?: boolean
    reason?: string
  }>
}

/** True when the owner has opted in to on-device STT (default OFF). */
export function isNativeSttEnabled(): boolean {
  try {
    return localStorage.getItem(NATIVE_STT_FLAG) === '1'
  } catch {
    return false
  }
}

/** Turn the owner-facing on-device STT preference on/off. */
export function setNativeSttEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(NATIVE_STT_FLAG, '1')
    else localStorage.removeItem(NATIVE_STT_FLAG)
  } catch {
    /* storage disabled — stay fail-open (feature simply stays off) */
  }
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
function getBridge(): NativeSpeechBridgePlugin | undefined {
  const plugins = (window as any)?.Capacitor?.Plugins
  const bridge = plugins?.NativeSpeechBridge
  if (bridge && typeof bridge.availability === 'function' && typeof bridge.transcribe === 'function') {
    return bridge as NativeSpeechBridgePlugin
  }
  return undefined
}

/** Base64 (no data-URL prefix) of a Blob, or null on failure. */
async function blobToBase64(blob: Blob): Promise<string | null> {
  try {
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  } catch {
    return null
  }
}

/**
 * Resolve the usable on-device speech bridge, or null if on-device STT can't be
 * used right now (non-native, old binary, flag off, plugin absent, or the
 * recognizer reports unavailable for `locale`). Fully fail-open.
 */
async function resolveBridge(locale: string): Promise<NativeSpeechBridgePlugin | null> {
  try {
    if (!isCapacitorNative()) return null
    if (!isNativeSttEnabled()) return null

    const build = await nativeBuildNumber()
    if (build == null || build < MIN_NATIVE_BUILD) return null

    const bridge = getBridge()
    if (!bridge) return null

    const status = await bridge.availability({ locale })
    if (!status?.available) return null

    return bridge
  } catch {
    return null
  }
}

/**
 * Attempt to transcribe `blob` on-device. Returns the transcript string on success,
 * or `null` if on-device STT is unavailable / disabled / produced nothing — in
 * which case the caller should fall back to the Whisper server path. Never throws.
 */
export async function maybeTranscribeOnDevice(
  blob: Blob,
  locale = 'bn-BD',
): Promise<string | null> {
  try {
    const bridge = await resolveBridge(locale)
    if (!bridge) return null

    const audioBase64 = await blobToBase64(blob)
    if (!audioBase64) return null

    const res = await bridge.transcribe({ audioBase64, locale })
    const text = typeof res?.text === 'string' ? res.text.trim() : ''
    if (res?.onDevice && text) return text
    return null
  } catch {
    return null
  }
}

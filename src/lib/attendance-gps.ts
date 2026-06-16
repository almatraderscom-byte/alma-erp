export type AttendanceGpsCoords = {
  latitude: number
  longitude: number
  accuracy: number
}

const GPS_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15_000,
}

function coordsFromPosition(pos: GeolocationPosition): AttendanceGpsCoords {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  }
}

/**
 * Native location path (Capacitor) — used when the page runs inside the iOS/Android
 * app shell. This gives a proper OS-level permission prompt and high-accuracy GPS,
 * which the in-app WebView's `navigator.geolocation` cannot reliably trigger. Falls
 * back to `null` (→ browser geolocation) when not on a native platform or on any error.
 */
async function getNativePositionOnce(): Promise<AttendanceGpsCoords | null> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor?.isNativePlatform?.()) return null

    const { Geolocation } = await import('@capacitor/geolocation')
    const perm = await Geolocation.checkPermissions()
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      const req = await Geolocation.requestPermissions()
      if (req.location !== 'granted' && req.coarseLocation !== 'granted') return null
    }

    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    })
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    }
  } catch {
    return null
  }
}

function getCurrentPositionOnce(): Promise<AttendanceGpsCoords | null> {
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve(coordsFromPosition(pos)),
      () => resolve(null),
      GPS_OPTIONS,
    )
  })
}

/** Fresh GPS fix for ALMA_LIFESTYLE attendance — high accuracy, no stale cache.
 *  Prefers the native Capacitor plugin inside the app shell, falling back to the
 *  browser Geolocation API on the web. */
export async function requireHighAccuracyLocation(): Promise<AttendanceGpsCoords | null> {
  const hardDeadline = new Promise<null>(resolve => {
    if (typeof window !== 'undefined') window.setTimeout(() => resolve(null), 18_000)
  })

  const acquire = async (): Promise<AttendanceGpsCoords | null> => {
    // 1) Native (iOS/Android app shell) — best accuracy + proper OS permission prompt.
    const native = await getNativePositionOnce()
    if (native) return native

    // 2) Browser fallback.
    if (typeof navigator === 'undefined' || !navigator.geolocation) return null
    let result = await getCurrentPositionOnce()
    if (result) return result
    // After permission dialog, browsers often need a short retry.
    await new Promise(r => window.setTimeout(r, 400))
    return getCurrentPositionOnce()
  }

  const result = await Promise.race([acquire(), hardDeadline])
  return result
}

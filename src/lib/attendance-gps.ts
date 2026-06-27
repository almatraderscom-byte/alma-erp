export type AttendanceGpsCoords = {
  latitude: number
  longitude: number
  accuracy: number
}

/**
 * Why a location fix could not be obtained. Lets the UI show an HONEST message:
 * only `denied` / `unsupported` mean "fix it in phone settings". `timeout` and
 * `unavailable` mean the GPS hardware just could not get a fix right now (indoors,
 * weak signal) and the staff member should move and retry — their settings are fine.
 */
export type AttendanceGpsReason =
  | 'ok'
  | 'denied'
  | 'timeout'
  | 'unavailable'
  | 'unsupported'

export type AttendanceGpsResult = {
  coords: AttendanceGpsCoords | null
  reason: AttendanceGpsReason
}

// First pass: a fresh, high-accuracy fix (no cache). Best quality.
const FRESH_HIGH_ACCURACY: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 12_000,
}

// Fallback pass: accept a slightly stale / coarse fix so staff indoors or on a
// weak signal can still check in. The server only enforces the 500m geofence and
// accepts ANY accuracy, so a coarse fix is safe and still rejects off-site spoofs.
const COARSE_CACHED: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 120_000,
  timeout: 10_000,
}

function coordsFromPosition(pos: GeolocationPosition): AttendanceGpsCoords {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  }
}

/** Combine two failure reasons, keeping the most actionable one.
 *  `denied`/`unsupported` (a real settings problem) beats a transient
 *  `timeout`/`unavailable`. */
function worseReason(a: AttendanceGpsReason, b: AttendanceGpsReason): AttendanceGpsReason {
  const rank: Record<AttendanceGpsReason, number> = {
    ok: 0,
    timeout: 1,
    unavailable: 2,
    unsupported: 3,
    denied: 4,
  }
  return rank[a] >= rank[b] ? a : b
}

/**
 * Native location path (Capacitor) — used when the page runs inside the iOS/Android
 * app shell. Gives a proper OS-level permission prompt and high-accuracy GPS, which
 * the in-app WebView's `navigator.geolocation` cannot reliably trigger. Distinguishes
 * "permission denied" from "could not get a fix" so the UI can advise correctly.
 * Returns reason `unsupported` when not running on a native platform (→ caller falls
 * back to the browser Geolocation API).
 */
async function getNativePosition(): Promise<AttendanceGpsResult> {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (!Capacitor?.isNativePlatform?.()) return { coords: null, reason: 'unsupported' }

    const { Geolocation } = await import('@capacitor/geolocation')
    let perm = await Geolocation.checkPermissions()
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      perm = await Geolocation.requestPermissions()
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        return { coords: null, reason: 'denied' }
      }
    }

    // Permission is granted — try a fresh high-accuracy fix, then a coarse/cached one.
    for (const opts of [FRESH_HIGH_ACCURACY, COARSE_CACHED]) {
      try {
        const pos = await Geolocation.getCurrentPosition(opts)
        return { coords: coordsFromPosition(pos as unknown as GeolocationPosition), reason: 'ok' }
      } catch {
        // try next tier
      }
    }
    // Permission granted but no fix could be obtained — hardware/signal issue.
    return { coords: null, reason: 'unavailable' }
  } catch {
    // Plugin not available / unexpected error — let the browser path try.
    return { coords: null, reason: 'unsupported' }
  }
}

function browserPositionOnce(opts: PositionOptions): Promise<AttendanceGpsResult> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ coords: null, reason: 'unsupported' })
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ coords: coordsFromPosition(pos), reason: 'ok' }),
      err => {
        // GeolocationPositionError: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        const reason: AttendanceGpsReason =
          err?.code === 1 ? 'denied' : err?.code === 3 ? 'timeout' : 'unavailable'
        resolve({ coords: null, reason })
      },
      opts,
    )
  })
}

/**
 * Acquire a location fix for attendance check-in with graceful degradation:
 *   1) Native Capacitor (high-accuracy → coarse/cached) inside the app shell.
 *   2) Browser high-accuracy (fresh).
 *   3) Browser coarse/cached fallback (indoors / weak signal).
 * Returns the first success, otherwise the most actionable failure reason so the
 * UI never tells staff to "enable GPS" when GPS is already on.
 */
export async function acquireAttendanceLocation(): Promise<AttendanceGpsResult> {
  const hardDeadline = new Promise<AttendanceGpsResult>(resolve => {
    if (typeof window !== 'undefined') {
      window.setTimeout(() => resolve({ coords: null, reason: 'timeout' }), 20_000)
    }
  })

  const acquire = async (): Promise<AttendanceGpsResult> => {
    let worst: AttendanceGpsReason = 'unavailable'

    // 1) Native (iOS/Android app shell).
    const native = await getNativePosition()
    if (native.coords) return native
    if (native.reason === 'denied') return native // a real settings problem — stop early
    if (native.reason !== 'unsupported') worst = worseReason(worst, native.reason)

    // 2) Browser — high accuracy, fresh.
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { coords: null, reason: worst === 'unavailable' ? 'unsupported' : worst }
    }
    const high = await browserPositionOnce(FRESH_HIGH_ACCURACY)
    if (high.coords) return high
    if (high.reason === 'denied') return high
    worst = worseReason(worst, high.reason)

    // 3) Browser — coarse / cached fallback (give the chip a moment after any prompt).
    await new Promise(r => window.setTimeout(r, 400))
    const coarse = await browserPositionOnce(COARSE_CACHED)
    if (coarse.coords) return coarse
    if (coarse.reason === 'denied') return coarse
    worst = worseReason(worst, coarse.reason)

    return { coords: null, reason: worst }
  }

  return Promise.race([acquire(), hardDeadline])
}

/** Backward-compatible wrapper: coords or null. Prefer `acquireAttendanceLocation`
 *  when you need to explain WHY a fix failed. */
export async function requireHighAccuracyLocation(): Promise<AttendanceGpsCoords | null> {
  const { coords } = await acquireAttendanceLocation()
  return coords
}

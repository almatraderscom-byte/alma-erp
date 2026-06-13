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

function getCurrentPositionOnce(): Promise<AttendanceGpsCoords | null> {
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve(coordsFromPosition(pos)),
      () => resolve(null),
      GPS_OPTIONS,
    )
  })
}

/** Fresh GPS fix for ALMA_LIFESTYLE attendance — high accuracy, no stale cache. */
export async function requireHighAccuracyLocation(): Promise<AttendanceGpsCoords | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null

  const hardDeadline = new Promise<null>(resolve => {
    window.setTimeout(() => resolve(null), 16_000)
  })

  const acquire = async () => {
    let result = await getCurrentPositionOnce()
    if (result) return result
    // After permission dialog, browsers often need a short retry.
    await new Promise(r => window.setTimeout(r, 400))
    return getCurrentPositionOnce()
  }

  const result = await Promise.race([acquire(), hardDeadline])
  return result
}

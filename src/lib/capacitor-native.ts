/** True when Alma ERP is running inside the Capacitor Android/iOS shell (not Chrome browser). */
export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

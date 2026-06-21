/** True when Alma ERP is running inside the Capacitor Android/iOS shell (not Chrome browser). */
export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

/**
 * Save an image to the device. A plain `<a download>` does NOT work inside the iOS
 * WKWebView shell — it just navigates to the URL in the browser, so the owner can
 * never actually save the file. Instead we fetch the image as a blob and hand it to
 * the native share sheet (Web Share API Level 2 → "Save Image" on iOS). On
 * desktop / Android browsers that lack file-sharing we fall back to a blob anchor,
 * which DOES download (unlike a cross-origin remote-URL anchor).
 *
 * @returns 'shared' | 'downloaded' | 'opened' — what actually happened, for UX copy.
 */
export async function saveImageToDevice(
  url: string,
  filename = `alma-${Date.now()}.jpg`,
): Promise<'shared' | 'downloaded' | 'opened'> {
  if (typeof window === 'undefined') return 'opened'
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    const blob = await res.blob()
    const type = blob.type || 'image/jpeg'
    const file = new File([blob], filename, { type })

    const nav = navigator as Navigator & {
      canShare?: (data?: { files?: File[] }) => boolean
      share?: (data: { files?: File[]; title?: string }) => Promise<void>
    }
    // Preferred on iOS WKWebView: native share sheet with the actual file → Save Image.
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file], title: filename })
        return 'shared'
      } catch (err) {
        // User cancelled the share sheet — treat as handled, don't fall through to a
        // blob download that would re-trigger another action.
        if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
        // otherwise fall through to anchor download
      }
    }

    // Fallback: blob URL anchor (works in Android WebView + desktop browsers).
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
    return 'downloaded'
  } catch {
    // Last resort: open in a new tab so the image is at least reachable.
    window.open(url, '_blank', 'noopener')
    return 'opened'
  }
}

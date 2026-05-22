/**
 * Full-viewport ambient light layer (CSS-only animation in globals.css).
 * Mounted once in root layout; pointer-events none; z-index 0 behind app chrome.
 */
export function AmbientBackground() {
  return (
    <div className="ambient-bg-root" aria-hidden="true">
      <div className="ambient-blob ambient-blob-1" />
      <div className="ambient-blob ambient-blob-2" />
      <div className="ambient-blob ambient-blob-3" />
    </div>
  )
}

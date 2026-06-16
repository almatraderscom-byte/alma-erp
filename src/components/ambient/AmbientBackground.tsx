/**
 * Full-viewport ambient light layer (CSS-only animation in globals.css).
 * Mounted once in root layout; pointer-events none; z-index 0 behind app chrome.
 * Warm coral/teal tinted — very subtle on the light background.
 */
export function AmbientBackground() {
  return (
    <div className="ambient-bg-root" aria-hidden="true">
      <div className="ambient-blob ambient-blob-1" style={{ opacity: 0.04, background: '#E07A5F' }} />
      <div className="ambient-blob ambient-blob-2" style={{ opacity: 0.03, background: '#81B29A' }} />
      <div className="ambient-blob ambient-blob-3" style={{ opacity: 0.035, background: '#D4A84B' }} />
    </div>
  )
}

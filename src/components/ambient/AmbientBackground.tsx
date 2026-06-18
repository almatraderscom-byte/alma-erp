/**
 * Full-viewport ambient aurora (lovable.dev-style vivid flowing gradient).
 * Mesh + drifting color blobs are defined in globals.css; mounted behind app
 * chrome (z-index 0, pointer-events none). GPU-only, reduced-motion-aware.
 */
export function AmbientBackground() {
  return (
    <div className="ambient-bg-root" aria-hidden="true">
      <div className="ambient-blob ambient-blob-1" />
      <div className="ambient-blob ambient-blob-2" />
      <div className="ambient-blob ambient-blob-3" />
      <div className="ambient-blob ambient-blob-4" />
      <div className="ambient-blob ambient-blob-5" />
    </div>
  )
}

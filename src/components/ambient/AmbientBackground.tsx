/**
 * Full-viewport ambient light layer (CSS-only drift animation in globals.css).
 * Mounted behind app chrome; pointer-events none; z-index 0. Two blobs track the
 * live accent token so the theme switcher recolors the whole glow in one toggle.
 */
export function AmbientBackground() {
  return (
    <div className="ambient-bg-root" aria-hidden="true">
      <div className="ambient-blob ambient-blob-1" style={{ background: 'rgb(var(--c-accent))' }} />
      <div className="ambient-blob ambient-blob-2" style={{ background: 'rgb(var(--c-accent-lt))' }} />
      <div className="ambient-blob ambient-blob-3" style={{ background: '#81B29A' }} />
    </div>
  )
}

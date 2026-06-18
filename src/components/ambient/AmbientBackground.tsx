import { AuroraCanvas } from './AuroraCanvas'

/**
 * Full-viewport ambient aurora (lovable.dev-style vivid flowing gradient).
 * The static base wash lives in globals.css (.ambient-bg-root); the drifting
 * color blobs are painted on a single low-res <canvas> (AuroraCanvas) so glass
 * panels stay smooth. Mounted behind app chrome (z-index -1, pointer-events none).
 */
export function AmbientBackground() {
  return (
    <div className="ambient-bg-root" aria-hidden="true">
      <AuroraCanvas />
    </div>
  )
}

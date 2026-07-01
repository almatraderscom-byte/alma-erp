/**
 * OrbFilters — invisible SVG holding the filters the orb references via
 * `filter: url(#id)` in CSS. Mount this ONCE near the app root.
 *
 *  #liquid          gentle organic edge wobble  (idle / listening)
 *  #liquidThinking  bigger wobble + blur         (thinking)
 *  #clouds1/#clouds2 fractal-noise -> white cloud wisps (alpha from red channel)
 *
 * Each filter animates its own turbulence (SMIL <animate>) so the surface is
 * never static. This is what makes the edge look fluid & "expensive".
 */
export default function OrbFilters() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <filter id="liquid" x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.009" numOctaves="2" seed="3" result="n">
            <animate attributeName="baseFrequency" dur="16s" values="0.008;0.013;0.008" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="11" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        <filter id="liquidThinking" x="-45%" y="-45%" width="190%" height="190%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="3" seed="5" result="n">
            <animate attributeName="baseFrequency" dur="6s" values="0.011;0.022;0.011" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="n" scale="28" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1.1" />
        </filter>

        <filter id="clouds1" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="4" stitchTiles="stitch">
            <animate attributeName="seed" dur="24s" values="4;11;4" repeatCount="indefinite" />
          </feTurbulence>
          {/* RGB -> white, Alpha = 1.1*R - 0.36  (only bright noise shows as wisps) */}
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.1 0 0 0 -0.36" />
        </filter>

        <filter id="clouds2" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.03 0.024" numOctaves="3" seed="9" stitchTiles="stitch">
            <animate attributeName="seed" dur="30s" values="9;2;9" repeatCount="indefinite" />
          </feTurbulence>
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.0 0 0 0 -0.42" />
        </filter>
      </defs>
    </svg>
  );
}

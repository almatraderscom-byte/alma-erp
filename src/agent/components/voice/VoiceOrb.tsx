'use client'

import type { VoiceState } from '@/agent/lib/voice-types'

/**
 * "Liquid Aurora" voice orb — a glass sphere with blue/purple/magenta/coral/cyan
 * blobs drifting inside it, mirroring the app's ambient aurora background. Pure
 * CSS (no WebGL context) so it stays light on the GPU and reads as part of the
 * aurora rather than a foreign element.
 *
 * The blob palette is constant (that's the aurora identity); each voice state
 * only changes drift speed + outer-glow color/intensity, and the listening state
 * additionally breathes the glow with the live mic level.
 */

type OrbPalette = { drift: string; glow: string }

const PALETTES: Record<VoiceState, OrbPalette> = {
  idle: { drift: '7s', glow: 'rgba(91,140,255,0.40)' },
  listening: { drift: '2.6s', glow: 'rgba(236,72,153,0.60)' },
  transcribing: { drift: '4.2s', glow: 'rgba(168,85,247,0.50)' },
  thinking: { drift: '4.2s', glow: 'rgba(168,85,247,0.50)' },
  speaking: { drift: '2.2s', glow: 'rgba(34,211,238,0.55)' },
  error: { drift: '6s', glow: 'rgba(224,122,95,0.50)' },
}

export function VoiceOrb({
  state = 'idle',
  micLevel = 0,
  size = 180,
  children,
}: {
  state?: VoiceState
  micLevel?: number
  size?: number
  children?: React.ReactNode
}) {
  const p = PALETTES[state] ?? PALETTES.idle
  const glowScale = state === 'listening' ? 1 + Math.min(Math.max(micLevel, 0), 1) * 0.3 : 1

  const cssVars = {
    '--drift': p.drift,
    '--glow': p.glow,
    width: size,
    height: size,
  } as React.CSSProperties

  return (
    <div
      className="alma-orb-shell"
      style={{ width: size, height: size, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div className="alma-orb" style={cssVars}>
        <div className="alma-orb__glow" style={{ transform: `scale(${glowScale})` }} />
        <div className="alma-orb__core">
          <div className="alma-orb__fluid">
            <span className="alma-orb__blob b1" />
            <span className="alma-orb__blob b2" />
            <span className="alma-orb__blob b3" />
            <span className="alma-orb__blob b4" />
          </div>
          <div className="alma-orb__spec" />
          <div className="alma-orb__shade" />
        </div>
      </div>

      {children ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' }}>
          {children}
        </div>
      ) : null}

      <style jsx>{`
        .alma-orb-shell {
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }
        .alma-orb {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .alma-orb__glow {
          position: absolute;
          inset: -26%;
          border-radius: 9999px;
          background: radial-gradient(circle, var(--glow) 0%, transparent 68%);
          filter: blur(10px);
          animation: almaGlowPulse var(--drift) ease-in-out infinite;
          will-change: transform, opacity;
        }
        .alma-orb__core {
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 9999px;
          overflow: hidden;
          background: radial-gradient(circle at 50% 44%, #2c2942 0%, #16151f 78%);
          box-shadow:
            0 18px 54px var(--glow),
            inset 0 0 0 1px rgba(255, 255, 255, 0.14),
            inset 0 -14px 34px rgba(0, 0, 0, 0.34);
        }
        .alma-orb__fluid {
          position: absolute;
          inset: -30%;
          filter: blur(18px) saturate(1.3);
          will-change: transform;
        }
        .alma-orb__blob {
          position: absolute;
          width: 70%;
          height: 70%;
          border-radius: 9999px;
          mix-blend-mode: screen;
          will-change: transform;
        }
        .b1 {
          top: -6%;
          left: -8%;
          background: radial-gradient(circle, #5b8cff 0%, transparent 62%);
          animation: almaFloat1 var(--drift) ease-in-out infinite;
        }
        .b2 {
          top: 30%;
          left: 38%;
          background: radial-gradient(circle, #ec4899 0%, transparent 62%);
          animation: almaFloat2 calc(var(--drift) * 1.12) ease-in-out infinite;
        }
        .b3 {
          top: 50%;
          left: -4%;
          background: radial-gradient(circle, #e07a5f 0%, transparent 62%);
          animation: almaFloat3 calc(var(--drift) * 0.9) ease-in-out infinite;
        }
        .b4 {
          top: 8%;
          left: 46%;
          background: radial-gradient(circle, #22d3ee 0%, transparent 62%);
          animation: almaFloat1 calc(var(--drift) * 1.25) ease-in-out infinite reverse;
        }
        .alma-orb__spec {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: radial-gradient(circle at 36% 30%, rgba(255, 255, 255, 0.82) 0%, transparent 32%);
          pointer-events: none;
          animation: almaShine var(--drift) ease-in-out infinite;
        }
        .alma-orb__shade {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: radial-gradient(circle at 70% 78%, rgba(0, 0, 0, 0.36) 0%, transparent 56%);
          pointer-events: none;
        }
        @keyframes almaGlowPulse {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.95; }
        }
        @keyframes almaShine {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
        @keyframes almaFloat1 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(14%, 18%); }
        }
        @keyframes almaFloat2 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-18%, 10%); }
        }
        @keyframes almaFloat3 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(10%, -16%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .alma-orb__glow,
          .alma-orb__blob,
          .alma-orb__spec {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  )
}

export default VoiceOrb

'use client'

import type { VoiceState } from '@/agent/lib/voice-types'

/**
 * Premium fluid "living" orb (Siri / ChatGPT voice style), built entirely from
 * layered radial-gradient blobs merged with a blur filter — no image asset, so
 * it animates continuously on the GPU and never suffers stale-cache issues.
 * Palette + motion speed react to the voice state; the listening glow also
 * breathes with the live mic level.
 */

type OrbPalette = {
  c1: string
  c2: string
  c3: string
  c4: string
  glow: string
  spin: string
  drift: string
}

const PALETTES: Record<VoiceState, OrbPalette> = {
  idle: {
    c1: '#F8EAE2', c2: '#EBC0AC', c3: '#DA8A6E', c4: '#b85540',
    glow: 'rgba(224,122,95,0.34)', spin: '22s', drift: '7s',
  },
  listening: {
    c1: '#FFE2CE', c2: '#F7B36B', c3: '#E9663F', c4: '#C73B2E',
    glow: 'rgba(231,102,63,0.55)', spin: '9s', drift: '2.6s',
  },
  transcribing: {
    c1: '#E6EFEA', c2: '#A6D2C4', c3: '#6FA9D6', c4: '#7C76C9',
    glow: 'rgba(129,178,154,0.45)', spin: '15s', drift: '4.2s',
  },
  thinking: {
    c1: '#E6EFEA', c2: '#A6D2C4', c3: '#6FA9D6', c4: '#7C76C9',
    glow: 'rgba(129,178,154,0.45)', spin: '15s', drift: '4.2s',
  },
  speaking: {
    c1: '#D9ECFF', c2: '#86B8F4', c3: '#5571E6', c4: '#7C3AED',
    glow: 'rgba(99,102,241,0.5)', spin: '7s', drift: '2.0s',
  },
  error: {
    c1: '#F8EAE2', c2: '#EBC0AC', c3: '#DA8A6E', c4: '#b85540',
    glow: 'rgba(224,122,95,0.34)', spin: '22s', drift: '7s',
  },
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
  const glowScale = state === 'listening' ? 1 + Math.min(micLevel, 1) * 0.28 : 1

  const cssVars = {
    '--c1': p.c1,
    '--c2': p.c2,
    '--c3': p.c3,
    '--c4': p.c4,
    '--glow': p.glow,
    '--spin': p.spin,
    '--drift': p.drift,
    width: size,
    height: size,
  } as React.CSSProperties

  return (
    <div className="alma-orb" style={cssVars}>
      <div className="alma-orb__glow" style={{ transform: `scale(${glowScale})` }} />
      <div className="alma-orb__core">
        <div className="alma-orb__fluid">
          <span className="alma-orb__blob b1" />
          <span className="alma-orb__blob b2" />
          <span className="alma-orb__blob b3" />
          <span className="alma-orb__blob b4" />
        </div>
        <div className="alma-orb__shade" />
        <div className="alma-orb__highlight" />
      </div>
      {children ? <div className="alma-orb__icon">{children}</div> : null}

      <style jsx>{`
        .alma-orb {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.3s ease;
        }
        .alma-orb__glow {
          position: absolute;
          inset: -28%;
          border-radius: 9999px;
          background: radial-gradient(circle, var(--glow) 0%, transparent 68%);
          filter: blur(8px);
          animation: almaGlow var(--drift) ease-in-out infinite;
          will-change: transform, opacity;
        }
        .alma-orb__core {
          position: relative;
          width: 100%;
          height: 100%;
          border-radius: 9999px;
          overflow: hidden;
          background: radial-gradient(circle at 50% 50%, var(--c2), var(--c4));
          box-shadow:
            0 16px 50px var(--glow),
            inset 0 -12px 32px rgba(0, 0, 0, 0.22),
            inset 0 10px 26px rgba(255, 255, 255, 0.32);
        }
        .alma-orb__fluid {
          position: absolute;
          inset: -12%;
          filter: blur(14px) saturate(1.25);
          animation: almaSpin var(--spin) linear infinite;
          will-change: transform;
        }
        .alma-orb__blob {
          position: absolute;
          border-radius: 9999px;
          will-change: transform;
        }
        .b1 {
          width: 78%; height: 78%; top: 4%; left: 2%;
          background: radial-gradient(circle, var(--c1) 0%, transparent 60%);
          animation: almaDrift1 var(--drift) ease-in-out infinite;
        }
        .b2 {
          width: 72%; height: 72%; bottom: 0%; right: 0%;
          background: radial-gradient(circle, var(--c3) 0%, transparent 60%);
          animation: almaDrift2 var(--drift) ease-in-out infinite;
          animation-delay: -1.2s;
        }
        .b3 {
          width: 64%; height: 64%; top: 22%; left: 26%;
          background: radial-gradient(circle, var(--c2) 0%, transparent 64%);
          animation: almaDrift3 var(--drift) ease-in-out infinite;
          animation-delay: -2.4s;
        }
        .b4 {
          width: 58%; height: 58%; top: 12%; right: 6%;
          background: radial-gradient(circle, var(--c1) 0%, transparent 56%);
          animation: almaDrift1 var(--drift) ease-in-out infinite reverse;
          animation-delay: -0.6s;
        }
        .alma-orb__shade {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: radial-gradient(circle at 70% 76%, rgba(0, 0, 0, 0.34) 0%, transparent 56%);
          pointer-events: none;
        }
        .alma-orb__highlight {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: radial-gradient(circle at 30% 25%, rgba(255, 255, 255, 0.62) 0%, transparent 42%);
          pointer-events: none;
          animation: almaShine var(--drift) ease-in-out infinite;
        }
        .alma-orb__icon {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        @keyframes almaSpin { to { transform: rotate(360deg); } }
        @keyframes almaGlow {
          0%, 100% { opacity: 0.55; }
          50% { opacity: 0.9; }
        }
        @keyframes almaShine {
          0%, 100% { opacity: 0.85; }
          50% { opacity: 1; }
        }
        @keyframes almaDrift1 {
          0%, 100% { transform: translate(-10%, -6%) scale(1); }
          50% { transform: translate(8%, 6%) scale(1.22); }
        }
        @keyframes almaDrift2 {
          0%, 100% { transform: translate(8%, 4%) scale(1.1); }
          50% { transform: translate(-8%, -6%) scale(0.85); }
        }
        @keyframes almaDrift3 {
          0%, 100% { transform: translate(0%, 0%) scale(0.95); }
          50% { transform: translate(-6%, 8%) scale(1.18); }
        }
        @media (prefers-reduced-motion: reduce) {
          .alma-orb__glow,
          .alma-orb__fluid,
          .alma-orb__blob,
          .alma-orb__highlight {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  )
}

export default VoiceOrb

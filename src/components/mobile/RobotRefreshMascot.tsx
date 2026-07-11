'use client'

/**
 * A friendly little robot mascot for pull-to-refresh (native iOS shell + mobile web).
 *
 * It reacts to the gesture the way the Claude app's characters do — it rises into
 * view as you pull, perks up and waves when you cross the release threshold, does a
 * cheerful "working" bob-and-spin while refreshing, then blinks happily on success.
 *
 * Pure SVG + CSS keyframes (no deps). `progress` (0→1) drives the pull-reactive bits;
 * `phase` drives the acting. Keyframes are injected once via a static <style> tag.
 */

type RobotPhase = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'success'

export function RobotRefreshMascot({
  phase,
  progress,
}: {
  phase: RobotPhase
  progress: number
}) {
  const p = Math.max(0, Math.min(1, progress))
  const ready = phase === 'ready'
  const working = phase === 'refreshing'
  const happy = phase === 'success'
  const eager = ready || working || happy

  // Pull-reactive: the robot rises + scales in as you pull; eyes glance down.
  const rise = working || happy ? 0 : (1 - p) * 14
  const scale = 0.7 + p * 0.3
  const eyeShiftY = working || happy ? 0 : (1 - p) * 1.4

  return (
    <div
      className="alma-ptr-robot"
      style={{
        transform: `translateY(${rise}px) scale(${working || happy ? 1 : scale})`,
        transition: 'transform 140ms cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      <style>{ROBOT_KEYFRAMES}</style>
      <svg width="40" height="44" viewBox="0 0 40 44" fill="none" aria-hidden="true">
        {/* soft glow */}
        <ellipse
          cx="20" cy="38" rx={9 - p * 2} ry="2.4"
          fill="rgba(201,168,76,0.25)"
          style={{ transition: 'all 160ms' }}
        />

        {/* the whole robot bobs while working */}
        <g className={working ? 'alma-ptr-bob' : happy ? 'alma-ptr-hop' : undefined}>
          {/* antenna */}
          <line x1="20" y1="9" x2="20" y2="4.5" stroke="#C9A84C" strokeWidth="1.6" strokeLinecap="round" />
          <circle
            cx="20" cy="3.4" r={eager ? 2.5 : 1.9}
            fill={eager ? '#F0C24B' : '#C9A84C'}
            className={working ? 'alma-ptr-antenna' : ready ? 'alma-ptr-pulse' : undefined}
            style={{ transition: 'all 200ms', filter: eager ? 'drop-shadow(0 0 4px rgba(240,194,75,0.9))' : undefined }}
          />

          {/* head */}
          <rect x="6" y="9" width="28" height="21" rx="8" fill="#FAF6EC" stroke="#C9A84C" strokeWidth="1.4" />
          {/* cheek blush when happy/ready */}
          {eager && (
            <>
              <circle cx="11" cy="23" r="2" fill="rgba(224,122,95,0.35)" />
              <circle cx="29" cy="23" r="2" fill="rgba(224,122,95,0.35)" />
            </>
          )}

          {/* eyes — blink while working/idle, curve up (^^) when happy/ready */}
          <g
            className={working ? 'alma-ptr-blink' : happy || ready ? undefined : 'alma-ptr-blink-slow'}
            style={{ transform: `translateY(${eyeShiftY}px)`, transformOrigin: '20px 19px' }}
          >
            {happy || ready ? (
              <>
                <path d="M11 20 q2.6 -3 5.2 0" stroke="#3A2F1A" strokeWidth="2" strokeLinecap="round" fill="none" />
                <path d="M23.8 20 q2.6 -3 5.2 0" stroke="#3A2F1A" strokeWidth="2" strokeLinecap="round" fill="none" />
              </>
            ) : (
              <>
                <circle cx="13.6" cy="19.5" r="2.5" fill="#3A2F1A" />
                <circle cx="26.4" cy="19.5" r="2.5" fill="#3A2F1A" />
                <circle cx="14.4" cy="18.7" r="0.8" fill="#FAF6EC" />
                <circle cx="27.2" cy="18.7" r="0.8" fill="#FAF6EC" />
              </>
            )}
          </g>

          {/* mouth */}
          {happy ? (
            <path d="M15 25.5 q5 4 10 0" stroke="#E07A5F" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          ) : (
            <path d="M16.5 26 q3.5 2 7 0" stroke="#C9A84C" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          )}

          {/* body */}
          <rect x="11" y="31" width="18" height="9" rx="3.4" fill="#EFE7D2" stroke="#C9A84C" strokeWidth="1.2" />
          <rect x="15.5" y="33.6" width="9" height="3.4" rx="1.7" fill={eager ? '#81B29A' : '#C9A84C'} style={{ transition: 'fill 200ms' }} />

          {/* left arm */}
          <line x1="10.5" y1="33" x2="6.5" y2="35.5" stroke="#C9A84C" strokeWidth="1.8" strokeLinecap="round" />
          {/* right arm — waves when ready */}
          <line
            x1="29.5" y1="33" x2="34" y2="31"
            stroke="#C9A84C" strokeWidth="1.8" strokeLinecap="round"
            className={ready ? 'alma-ptr-wave' : undefined}
            style={{ transformOrigin: '29.5px 33px' }}
          />
        </g>
      </svg>
    </div>
  )
}

const ROBOT_KEYFRAMES = `
.alma-ptr-robot svg { display:block; overflow:visible; }
@keyframes almaPtrBob { 0%,100%{ transform:translateY(0) } 50%{ transform:translateY(-2.5px) } }
@keyframes almaPtrHop { 0%{ transform:translateY(0) } 30%{ transform:translateY(-6px) } 60%{ transform:translateY(0) } 100%{ transform:translateY(0) } }
@keyframes almaPtrBlink { 0%,42%,58%,100%{ transform:scaleY(1) } 50%{ transform:scaleY(0.12) } }
@keyframes almaPtrBlinkSlow { 0%,92%,100%{ transform:scaleY(1) } 96%{ transform:scaleY(0.12) } }
@keyframes almaPtrPulse { 0%,100%{ opacity:1; transform:scale(1) } 50%{ opacity:0.55; transform:scale(1.25) } }
@keyframes almaPtrAntenna { 0%{ transform:scale(1); opacity:1 } 50%{ transform:scale(1.4); opacity:0.6 } 100%{ transform:scale(1); opacity:1 } }
@keyframes almaPtrWave { 0%,100%{ transform:rotate(0deg) } 25%{ transform:rotate(-22deg) } 75%{ transform:rotate(14deg) } }
.alma-ptr-bob { animation: almaPtrBob 0.9s ease-in-out infinite; }
.alma-ptr-hop { animation: almaPtrHop 0.5s ease-out; }
.alma-ptr-blink { transform-box: fill-box; transform-origin: center; animation: almaPtrBlink 1.1s ease-in-out infinite; }
.alma-ptr-blink-slow { transform-box: fill-box; transform-origin: center; animation: almaPtrBlinkSlow 3.6s ease-in-out infinite; }
.alma-ptr-pulse { transform-box: fill-box; transform-origin: center; animation: almaPtrPulse 0.8s ease-in-out infinite; }
.alma-ptr-antenna { transform-box: fill-box; transform-origin: center; animation: almaPtrAntenna 0.6s ease-in-out infinite; }
.alma-ptr-wave { animation: almaPtrWave 0.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .alma-ptr-bob,.alma-ptr-hop,.alma-ptr-blink,.alma-ptr-blink-slow,.alma-ptr-pulse,.alma-ptr-antenna,.alma-ptr-wave { animation: none; }
}
`

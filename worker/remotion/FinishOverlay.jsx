// Phase V3 — the five deterministic motion templates. Every timing decision
// arrives in the plan (frame-exact, unit-tested app-side); these components
// only animate what the plan dictates: spring pops, slide-ins, fades.
// Rendered with a TRANSPARENT background — ffmpeg composites the result over
// the reel, so the video itself is never touched by Chrome.
import React from 'react'
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  staticFile,
} from 'remotion'

const FONT = 'Noto Sans Bengali'
const bnDigits = (v) => String(v).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d])
const BRAND_ORANGE = '#E07A5F'
const BRAND_DARK = '#141019'

const fontCss = `@font-face {
  font-family: '${FONT}';
  src: url('${staticFile('NotoSansBengali.ttf')}') format('truetype');
}`

/** scale factor so the same layout works for 1080×1920, 1080×1080, 1920×1080 */
const useScale = () => {
  const { height } = useVideoConfig()
  return height / 1920
}

const PricePop = ({ price }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = useScale()
  const pop = spring({ frame, fps, config: { damping: 10, stiffness: 120, mass: 0.6 } })
  return (
    <div
      style={{
        position: 'absolute',
        right: 40 * s,
        bottom: 480 * s,
        transform: `scale(${pop}) rotate(${interpolate(pop, [0, 1], [-12, -4])}deg)`,
        transformOrigin: 'bottom right',
        background: BRAND_ORANGE,
        color: '#fff',
        fontFamily: FONT,
        fontWeight: 700,
        fontSize: 68 * s,
        padding: `${14 * s}px ${34 * s}px`,
        borderRadius: 18 * s,
        boxShadow: `0 ${8 * s}px ${24 * s}px rgba(0,0,0,0.35)`,
      }}
    >
      ৳ {price}
    </div>
  )
}

const LowerThird = ({ code, name, durationInFrames }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = useScale()
  const enter = spring({ frame, fps, config: { damping: 14, stiffness: 90 } })
  const exit = interpolate(frame, [durationInFrames - Math.round(fps * 0.4), durationInFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })
  const x = interpolate(enter, [0, 1], [-600 * s, 0]) - exit * 700 * s
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        bottom: 620 * s,
        transform: `translateX(${x}px)`,
        background: 'rgba(20,16,25,0.85)',
        borderLeft: `${10 * s}px solid ${BRAND_ORANGE}`,
        color: '#fff',
        fontFamily: FONT,
        padding: `${16 * s}px ${36 * s}px ${16 * s}px ${28 * s}px`,
        borderRadius: `0 ${16 * s}px ${16 * s}px 0`,
      }}
    >
      <div style={{ fontSize: 52 * s, fontWeight: 700, letterSpacing: 1 }}>{code}</div>
      {name ? <div style={{ fontSize: 36 * s, opacity: 0.85 }}>{name}</div> : null}
    </div>
  )
}

const LogoWatermark = ({ logoDataUrl }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = useScale()
  if (!logoDataUrl) return null
  const enter = spring({ frame, fps, config: { damping: 16 } })
  return (
    <img
      src={logoDataUrl}
      alt=""
      style={{
        position: 'absolute',
        top: 46 * s,
        right: 40 * s,
        width: 200 * s,
        opacity: 0.9 * enter,
        transform: `translateY(${interpolate(enter, [0, 1], [-40 * s, 0])}px)`,
      }}
    />
  )
}

const Countdown = ({ days }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = useScale()
  const enter = spring({ frame, fps, config: { damping: 12 } })
  // deterministic 1s pulse
  const pulse = 1 + 0.06 * Math.sin((frame / fps) * Math.PI * 2)
  return (
    <div
      style={{
        position: 'absolute',
        left: 40 * s,
        top: 150 * s,
        transform: `scale(${enter * pulse})`,
        transformOrigin: 'top left',
        background: '#B3261E',
        color: '#fff',
        fontFamily: FONT,
        fontWeight: 700,
        fontSize: 40 * s,
        padding: `${12 * s}px ${26 * s}px`,
        borderRadius: 999,
        boxShadow: `0 ${6 * s}px ${18 * s}px rgba(0,0,0,0.35)`,
      }}
    >
      অফার শেষ হতে {bnDigits(days)} দিন
    </div>
  )
}

const EndCard = ({ cta, code, price, logoDataUrl, durationInFrames }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const s = useScale()
  const fade = interpolate(frame, [0, Math.round(fps * 0.4)], [0, 1], {
    extrapolateRight: 'clamp',
  })
  const rise = spring({ frame, fps, config: { damping: 14 } })
  return (
    <AbsoluteFill
      style={{
        background: BRAND_DARK,
        opacity: fade,
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        color: '#fff',
        flexDirection: 'column',
        gap: 30 * s,
      }}
    >
      {logoDataUrl ? (
        <img src={logoDataUrl} alt="" style={{ width: 460 * s, transform: `translateY(${(1 - rise) * 60 * s}px)` }} />
      ) : null}
      {code || price ? (
        <div style={{ fontSize: 48 * s, fontWeight: 700, color: BRAND_ORANGE }}>
          {[code, price ? `৳ ${price}` : ''].filter(Boolean).join(' · ')}
        </div>
      ) : null}
      <div
        style={{
          fontSize: 56 * s,
          fontWeight: 700,
          background: BRAND_ORANGE,
          padding: `${18 * s}px ${52 * s}px`,
          borderRadius: 999,
          transform: `translateY(${(1 - rise) * 80 * s}px)`,
        }}
      >
        {cta}
      </div>
      <div style={{ fontSize: 34 * s, opacity: 0.75, marginTop: 8 * s }}>almatraders.com</div>
    </AbsoluteFill>
  )
}

const COMPONENTS = {
  price_pop: PricePop,
  lower_third: LowerThird,
  logo_watermark: LogoWatermark,
  countdown: Countdown,
  end_card: EndCard,
}

export const FinishOverlay = ({ plan, logoDataUrl }) => (
  <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
    <style>{fontCss}</style>
    {plan.items.map((item, i) => {
      const Comp = COMPONENTS[item.kind]
      if (!Comp) return null
      return (
        <Sequence key={i} from={item.from} durationInFrames={item.durationInFrames}>
          <Comp {...item.props} logoDataUrl={logoDataUrl} durationInFrames={item.durationInFrames} />
        </Sequence>
      )
    })}
  </AbsoluteFill>
)

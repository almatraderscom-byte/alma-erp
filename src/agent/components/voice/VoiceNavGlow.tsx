'use client'

/**
 * VoiceNavGlow — the Siri / Apple-Intelligence "liquid glass" edge glow that
 * wraps ALL screen edges while the voice navigator is active.
 *
 * A full-screen, pointer-events:none overlay. ONE continuous multicolor neon
 * gradient (pink → purple → blue → cyan → orange) wraps the whole rounded
 * screen border, softly diffused and fading outward, slowly rotating and gently
 * breathing — the same feel as iPhone's Siri listening animation. The center
 * stays clear so the app underneath is fully visible. Fades in/out with the
 * navigator state (listening → thinking → going).
 *
 * Fully self-contained: it injects its own scoped CSS so it works on every
 * portal page without touching globals.css, masks the glow to the border
 * region, and reads <html data-theme> so it reads beautifully in BOTH light
 * (cream) and dark backgrounds. Honors prefers-reduced-motion.
 */
interface VoiceNavGlowProps {
  active: boolean
}

const SIRI_CSS = `
@property --alma-sa{syntax:'<angle>';inherits:false;initial-value:0deg}
@property --alma-sb{syntax:'<angle>';inherits:false;initial-value:0deg}
.alma-siri{position:fixed;inset:0;pointer-events:none;z-index:70;opacity:0;visibility:hidden;transition:opacity .8s ease;will-change:opacity;overflow:hidden}
.alma-siri.is-on{opacity:1;visibility:visible}
.alma-siri-inner{position:absolute;inset:0;animation:alma-siri-pulse 4s ease-in-out infinite}
/* No geometric frame. Each layer is a soft, heavily-blurred colour FIELD masked by
   a feathered radial vignette (clear-ish center, glowing toward the edges with NO
   hard rounded-rect outline). Two counter-rotating fields drift over each other so
   the bright spots flow around the perimeter — the Apple-Siri "liquid glass" feel.
   The layers extend past the viewport so the brightest ring sits right at the edge
   and the corners melt softly instead of forming a shape. */
.alma-siri-inner>div{position:absolute;inset:-8%;will-change:transform;mix-blend-mode:screen}
.alma-siri-field{filter:blur(32px);opacity:1;background:conic-gradient(from var(--alma-sa),#ff2a9e,#c83cff,#6a4dff,#2e82ff,#16d6ff,#ff7a2a,#ff2a9e);-webkit-mask:radial-gradient(104% 96% at 50% 50%,transparent 24%,#000 66%);mask:radial-gradient(104% 96% at 50% 50%,transparent 24%,#000 66%);animation:alma-siri-spin-a 9s linear infinite,alma-siri-breathe 4.2s ease-in-out infinite}
.alma-siri-flow{filter:blur(48px);opacity:.92;background:conic-gradient(from var(--alma-sb),#16d6ff,#6a4dff,#ff2a9e,#ff7a2a,#2e82ff,#c83cff,#16d6ff);-webkit-mask:radial-gradient(118% 110% at 50% 45%,transparent 34%,#000 92%);mask:radial-gradient(118% 110% at 50% 45%,transparent 34%,#000 92%);animation:alma-siri-spin-b 6.5s linear infinite,alma-siri-drift 7.5s ease-in-out infinite}
@keyframes alma-siri-spin-a{to{--alma-sa:360deg}}
@keyframes alma-siri-spin-b{to{--alma-sb:-360deg}}
@keyframes alma-siri-pulse{0%,100%{opacity:.9}50%{opacity:1}}
@keyframes alma-siri-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
@keyframes alma-siri-drift{0%,100%{transform:scale(1.04) translate(0,0)}33%{transform:scale(1.08) translate(1.5%,-1%)}66%{transform:scale(1.02) translate(-1.5%,1.5%)}}
:root[data-theme='light'] .alma-siri-field{opacity:.6;mix-blend-mode:multiply}
:root[data-theme='light'] .alma-siri-flow{opacity:.5;mix-blend-mode:multiply}
@media (prefers-reduced-motion:reduce){.alma-siri-inner,.alma-siri-field,.alma-siri-flow{animation:none}}
`

export function VoiceNavGlow({ active }: VoiceNavGlowProps) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: SIRI_CSS }} />
      <div className={`alma-siri${active ? ' is-on' : ''}`} aria-hidden="true">
        <div className="alma-siri-inner">
          <div className="alma-siri-field" />
          <div className="alma-siri-flow" />
        </div>
      </div>
    </>
  )
}

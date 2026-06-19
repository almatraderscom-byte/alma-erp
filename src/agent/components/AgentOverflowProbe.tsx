'use client'

import { useEffect, useState } from 'react'

/**
 * TEMPORARY on-device diagnostic for the "screen cut / shifted sideways" bug.
 *
 * It scans the live DOM for the element whose right edge extends past the visual
 * viewport (the thing that makes WKWebView widen the layout viewport and clip the
 * whole page on iPhone), outlines it red, and shows a banner naming it. It renders
 * NOTHING when the layout is healthy, so on a normal screen it is invisible — it
 * only appears at the exact moment the bug reproduces, which is the live evidence.
 *
 * Remove once the culprit element is identified and fixed.
 */
export function AgentOverflowProbe() {
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    let raf = 0

    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase()
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.')
          : ''
      return `${tag}${cls}`
    }

    function scan() {
      const vw = window.innerWidth
      let worst: { el: Element; right: number; w: number } | null = null

      document.querySelectorAll('body *').forEach((el) => {
        // ignore the probe's own banner / outline marker
        if (el.hasAttribute('data-ovf-probe') || el.hasAttribute('data-ovf-banner')) return
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        if (r.right > vw + 1 && (!worst || r.right > worst.right)) {
          worst = { el, right: r.right, w: r.width }
        }
      })

      const docW = document.documentElement.scrollWidth
      const scale = window.visualViewport ? window.visualViewport.scale : 1

      document.querySelectorAll('[data-ovf-probe]').forEach((e) => {
        ;(e as HTMLElement).style.outline = ''
        e.removeAttribute('data-ovf-probe')
      })

      if (worst) {
        const w = worst as { el: Element; right: number; w: number }
        const el = w.el as HTMLElement
        el.style.outline = '3px solid #ef4444'
        el.style.outlineOffset = '-1px'
        el.setAttribute('data-ovf-probe', '1')
        setInfo(
          `⚠︎ OVERFLOW <${describe(w.el)}> right=${Math.round(w.right)} w=${Math.round(w.w)} vw=${vw} docW=${docW} scale=${scale.toFixed(2)}`,
        )
      } else if (docW > vw + 1) {
        // No single element crosses the edge but the document is still wider than
        // the screen → a position:fixed / transformed element or pseudo-element.
        setInfo(`⚠︎ docW=${docW} > vw=${vw} scale=${scale.toFixed(2)} — no DOM child crosses edge (fixed/transform/::before?)`)
      } else {
        setInfo(null)
      }
    }

    const onChange = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(scan)
    }

    scan()
    const obs = new MutationObserver(onChange)
    obs.observe(document.body, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', onChange)
    window.visualViewport?.addEventListener('resize', onChange)
    const iv = setInterval(scan, 1500)

    return () => {
      obs.disconnect()
      window.removeEventListener('resize', onChange)
      window.visualViewport?.removeEventListener('resize', onChange)
      clearInterval(iv)
      cancelAnimationFrame(raf)
      document.querySelectorAll('[data-ovf-probe]').forEach((e) => {
        ;(e as HTMLElement).style.outline = ''
        e.removeAttribute('data-ovf-probe')
      })
    }
  }, [])

  if (!info) return null

  return (
    <div
      data-ovf-banner="1"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 99999,
        maxWidth: '100vw',
        background: 'rgba(220,38,38,0.96)',
        color: '#fff',
        font: '11px/1.35 ui-monospace, monospace',
        padding: '4px 8px',
        pointerEvents: 'none',
        wordBreak: 'break-all',
      }}
    >
      {info}
    </div>
  )
}

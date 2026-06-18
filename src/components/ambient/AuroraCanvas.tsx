'use client'

import { useEffect, useRef } from 'react'

/**
 * Tier-S aurora renderer. Instead of 5 full-viewport DOM blobs each running an
 * animated `filter: blur(110px)` (which forces the GPU to recompute a huge
 * gaussian blur every frame AND makes every overlapping `backdrop-filter` glass
 * panel re-blur a moving layer), we paint the same drifting color blobs onto a
 * single low-resolution <canvas>. The browser upscales that small bitmap to the
 * full viewport — the upscale itself smooths it into a soft, dreamy wash, so the
 * look is preserved while the per-frame cost collapses to one cheap raster.
 *
 * Glass panels keep their live backdrop-filter; they now sample this flat canvas
 * instead of five stacked blur layers, so the whole UI stays smooth.
 *
 * Colors are read from the same --aurora-blob-* CSS tokens (theme-reactive),
 * so light/dark and any palette tweak stay single-sourced in globals.css.
 */

type Blob = { bx: number; by: number; ax: number; ay: number; period: number; phase: number }

// Layout mirrors the previous DOM blobs (top-left, top-right, center, bottom-left,
// bottom-right) as fractions of the canvas, with per-blob drift amplitude/period.
const BLOBS: Blob[] = [
  { bx: 0.12, by: 0.14, ax: 0.30, ay: 0.22, period: 34, phase: 0.0 },
  { bx: 0.88, by: 0.10, ax: 0.28, ay: 0.24, period: 42, phase: 1.3 },
  { bx: 0.46, by: 0.42, ax: 0.30, ay: 0.26, period: 38, phase: 2.1 },
  { bx: 0.12, by: 0.86, ax: 0.34, ay: 0.22, period: 46, phase: 3.4 },
  { bx: 0.86, by: 0.84, ax: 0.30, ay: 0.24, period: 40, phase: 4.7 },
]

type RGBA = { r: number; g: number; b: number; a: number }

function parseRGBA(input: string): RGBA | null {
  const m = input.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i)
  if (!m) return null
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 }
}

function readPalette(): { colors: RGBA[]; opacity: number } {
  const cs = getComputedStyle(document.documentElement)
  const colors: RGBA[] = []
  for (let i = 1; i <= 5; i++) {
    const c = parseRGBA(cs.getPropertyValue(`--aurora-blob-${i}`).trim())
    if (c) colors.push(c)
  }
  const op = parseFloat(cs.getPropertyValue('--aurora-blob-opacity')) || 0.9
  return { colors, opacity: op }
}

export function AuroraCanvas() {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let palette = readPalette()
    let w = 0
    let h = 0

    // Low internal resolution: gradients are smooth, so a tiny bitmap upscaled to
    // the viewport looks identically soft while costing a fraction to paint.
    const resize = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const scale = 0.4
      w = Math.max(64, Math.min(Math.round(vw * scale), 600))
      h = Math.max(64, Math.round((w * vh) / Math.max(vw, 1)))
      canvas.width = w
      canvas.height = h
    }
    resize()

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    const drawFrame = (timeSec: number) => {
      ctx.clearRect(0, 0, w, h)
      const radius = 0.72 * Math.max(w, h)
      const blobs = BLOBS.length
      for (let i = 0; i < blobs; i++) {
        const col = palette.colors[i]
        if (!col) continue
        const b = BLOBS[i]
        const ang = (2 * Math.PI * timeSec) / b.period + b.phase
        const x = (b.bx + b.ax * Math.sin(ang)) * w
        const y = (b.by + b.ay * Math.cos(ang * 0.9 + b.phase)) * h
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius)
        const a0 = col.a * palette.opacity
        grad.addColorStop(0, `rgba(${col.r},${col.g},${col.b},${a0})`)
        grad.addColorStop(0.5, `rgba(${col.r},${col.g},${col.b},${a0 * 0.45})`)
        grad.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`)
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, w, h)
      }
    }

    let raf = 0
    let lastDraw = 0
    const start = performance.now()

    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      const now = performance.now()
      // ~30fps is plenty for a slow aurora; halves paint cost vs 60fps.
      if (now - lastDraw < 33) return
      lastDraw = now
      drawFrame((now - start) / 1000)
    }

    if (reduceMotion) {
      drawFrame(0)
    } else {
      raf = requestAnimationFrame(loop)
    }

    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    // Re-read palette when the theme attribute flips (light/dark).
    const obs = new MutationObserver(() => {
      palette = readPalette()
      if (reduceMotion) drawFrame(0)
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      obs.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="ambient-canvas" aria-hidden="true" />
}

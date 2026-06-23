'use client'

/**
 * Drag / resize editor for the full-bleed "lifestyle poster" finishing layout.
 *
 * Auto-finish already produces a good layout; this lets the owner nudge any block
 * by touch or mouse when a line is too long/short or sits awkwardly, then render
 * the final crisp image at those exact positions. It is seeded from
 * `computeAutoLayout(...)` — the SAME geometry the server uses — so what is dragged
 * here is what gets rendered. On apply it sends back only geometry (positions /
 * sizes); text + wrapping stay server-authoritative.
 *
 * Works on phone and desktop: all gestures use Pointer Events (touch + mouse).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  LIFESTYLE_SIZE,
  LIFESTYLE_COLORS,
  LIFESTYLE_FONT,
  computeAutoLayout,
  type LifestyleLayout,
  type LifestyleLayoutOverrides,
  type LifestyleText,
} from '@/lib/content-engine/lifestyle-layout'

type ElId = 'eyebrow' | 'headline' | 'offer' | 'est' | 'codeBadge' | 'rule' | 'monogram' | 'logo'

type DragState = {
  kind: 'move' | 'resize'
  id: ElId
  startClientX: number
  startClientY: number
  orig: LifestyleLayout[ElId]
} | null

/** @font-face for the brand fonts so the preview matches the server raster. */
const FONT_FACE_CSS = `
@font-face{font-family:'AlmaSerif';src:url('/fonts/brand/NotoSerifBengali-Regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap;}
@font-face{font-family:'AlmaSerif';src:url('/fonts/brand/NotoSerifBengali-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:swap;}
@font-face{font-family:'AlmaDisplay';src:url('/fonts/brand/PlayfairDisplay-Regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap;}
`

export type LifestyleEditorProps = {
  imageUrl: string
  logoUrl: string | null
  accent: string
  /** resolved text (brand defaults already applied) — must match what the server uses */
  texts: LifestyleText
  /** 'cover' crops the photo to a square; 'contain' shows the whole photo (no crop) */
  fit?: 'cover' | 'contain'
  busy?: boolean
  onCancel: () => void
  onApply: (overrides: LifestyleLayoutOverrides) => void
}

export default function LifestyleEditor({
  imageUrl,
  logoUrl,
  accent,
  texts,
  fit = 'cover',
  busy = false,
  onCancel,
  onApply,
}: LifestyleEditorProps) {
  const auto = useMemo(() => computeAutoLayout(texts), [texts])
  const [layout, setLayout] = useState<LifestyleLayout>(auto)
  const [selected, setSelected] = useState<ElId | null>(null)
  const [logoAspect, setLogoAspect] = useState(0.32) // height/width fallback until the logo loads

  // Portal to <body>: the editor is rendered inside a Framer-Motion lightbox whose
  // `transform` would otherwise trap our `position:fixed` to that box (the footer
  // buttons then overlap the app's bottom tab bar). Portalling escapes it.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(0)
  const scale = boxW > 0 ? boxW / LIFESTYLE_SIZE : 0
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const drag = useRef<DragState>(null)

  // Re-seed if the text changes upstream (e.g. owner edits a field then reopens).
  useEffect(() => setLayout(auto), [auto])

  // Track the on-screen size of the square so we can map design ↔ screen pixels.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const update = () => setBoxW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const px = useCallback((v: number) => v * scale, [scale])

  // ---- gesture handlers -------------------------------------------------
  const onPointerDownEl = (id: ElId) => (e: React.PointerEvent) => {
    e.stopPropagation()
    setSelected(id)
    // Capture on the handler's own element (not e.target, which may be an inner
    // line <div>) so the matching onPointerMove keeps receiving events.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      kind: 'move',
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      orig: { ...layout[id] } as LifestyleLayout[ElId],
    }
  }

  const onPointerDownResize = (id: ElId) => (e: React.PointerEvent) => {
    e.stopPropagation()
    setSelected(id)
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = {
      kind: 'resize',
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      orig: { ...layout[id] } as LifestyleLayout[ElId],
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    const s = scaleRef.current
    if (!d || s <= 0) return
    const dx = (e.clientX - d.startClientX) / s
    const dy = (e.clientY - d.startClientY) / s
    setLayout((prev) => applyGesture(prev, d, dx, dy))
  }

  const endDrag = () => {
    drag.current = null
  }

  const reset = () => {
    setLayout(auto)
    setSelected(null)
  }

  const apply = () => {
    onApply({
      eyebrow: { x: r(layout.eyebrow.x), y: r(layout.eyebrow.y), size: r(layout.eyebrow.size) },
      headline: { x: r(layout.headline.x), y: r(layout.headline.y), size: r(layout.headline.size), leading: r(layout.headline.leading) },
      offer: { x: r(layout.offer.x), y: r(layout.offer.y), size: r(layout.offer.size), leading: r(layout.offer.leading) },
      est: { x: r(layout.est.x), y: r(layout.est.y), size: r(layout.est.size) },
      codeBadge: { cx: r(layout.codeBadge.cx), cy: r(layout.codeBadge.cy), r: r(layout.codeBadge.r), size: r(layout.codeBadge.size) },
      rule: { x: r(layout.rule.x), y: r(layout.rule.y), w: r(layout.rule.w) },
      monogram: { cx: r(layout.monogram.cx), cy: r(layout.monogram.cy), r: r(layout.monogram.r), size: r(layout.monogram.size) },
      logo: { x: r(layout.logo.x), y: r(layout.logo.y), w: r(layout.logo.w) },
    })
  }

  // ---- render -----------------------------------------------------------
  const sel = (id: ElId) => selected === id

  if (!mounted) return null

  const ui = (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/95 backdrop-blur-sm">
      <style>{FONT_FACE_CSS}</style>

      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button type="button" onClick={onCancel} className="text-[13px] text-white/70">✕ বাতিল</button>
        <span className="text-[12px] text-white/60">টেনে সরান · কোণা টেনে ছোট-বড়</span>
        <button type="button" onClick={reset} className="text-[13px] text-white/70">↺ আগের মতো</button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden px-3">
        <div
          ref={boxRef}
          onPointerDown={() => setSelected(null)}
          className="relative aspect-square w-full max-w-[min(92vw,560px)] select-none overflow-hidden rounded-xl"
          style={{ touchAction: 'none' }}
        >
          {/* background photo — matches the server: 'cover' crops to square,
              'contain' shows the whole photo over a blurred fill (no crop) */}
          {fit === 'contain' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover blur-xl brightness-[0.65]" draggable={false} />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className={`absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`} draggable={false} />
          {/* top + bottom scrims to match the render */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: px(240), background: `linear-gradient(${LIFESTYLE_COLORS.charcoal}57, transparent)` }} />
          <div className="pointer-events-none absolute inset-x-0" style={{ top: px(560), height: px(520), background: `linear-gradient(transparent, ${LIFESTYLE_COLORS.charcoal}73 52%, ${LIFESTYLE_COLORS.charcoal}e6)` }} />

          {scale > 0 && (
            <>
              {/* logo */}
              {logoUrl && (
                <Movable selected={sel('logo')} onDown={onPointerDownEl('logo')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('logo')}
                  style={{ left: px(layout.logo.x), top: px(layout.logo.y), width: px(layout.logo.w), height: px(layout.logo.w * logoAspect) }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={logoUrl} alt="" draggable={false} className="pointer-events-none h-full w-full object-contain"
                    onLoad={(e) => { const t = e.currentTarget; if (t.naturalWidth) setLogoAspect(t.naturalHeight / t.naturalWidth) }} />
                </Movable>
              )}

              {/* CODE badge (label + ring + code) */}
              <Movable selected={sel('codeBadge')} onDown={onPointerDownEl('codeBadge')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('codeBadge')}
                center style={{ left: px(layout.codeBadge.cx), top: px(layout.codeBadge.cy), width: px(layout.codeBadge.r * 2), height: px(layout.codeBadge.r * 2) }}>
                {/* soft charcoal disc keeps the code legible on any photo + de-emphasises the roundel */}
                <div className="pointer-events-none absolute inset-0 rounded-full" style={{ background: LIFESTYLE_COLORS.charcoal, opacity: 0.26 }} />
                <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap"
                  style={{ top: px(layout.codeBadge.labelDy - layout.codeBadge.labelSize), color: LIFESTYLE_COLORS.cream, opacity: 0.72, fontFamily: LIFESTYLE_FONT.display, fontSize: px(layout.codeBadge.labelSize), letterSpacing: px(3) }}>
                  {layout.codeBadge.label}
                </div>
                <div className="pointer-events-none absolute inset-0 rounded-full" style={{ border: `${Math.max(1, px(1.5))}px solid ${LIFESTYLE_COLORS.cream}`, opacity: 0.8 }} />
                {layout.codeBadge.code && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center whitespace-nowrap font-bold"
                    style={{ color: LIFESTYLE_COLORS.cream, fontFamily: LIFESTYLE_FONT.serif, fontSize: px(layout.codeBadge.size) }}>
                    {layout.codeBadge.code.slice(0, 16)}
                  </div>
                )}
              </Movable>

              {/* text blocks */}
              <TextBlock el={layout.eyebrow} accent={accent} scale={scale} selected={sel('eyebrow')}
                onDown={onPointerDownEl('eyebrow')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('eyebrow')} />
              <TextBlock el={layout.headline} accent={accent} scale={scale} selected={sel('headline')}
                onDown={onPointerDownEl('headline')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('headline')} />
              <TextBlock el={layout.offer} accent={accent} scale={scale} selected={sel('offer')}
                onDown={onPointerDownEl('offer')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('offer')} />
              <TextBlock el={layout.est} accent={accent} scale={scale} selected={sel('est')}
                onDown={onPointerDownEl('est')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('est')} />

              {/* mustard rule */}
              <Movable selected={sel('rule')} onDown={onPointerDownEl('rule')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('rule')}
                style={{ left: px(layout.rule.x), top: px(layout.rule.y), width: px(layout.rule.w), height: Math.max(2, px(layout.rule.h)) }}>
                <div className="pointer-events-none h-full w-full" style={{ background: accent }} />
              </Movable>

              {/* monogram */}
              <Movable selected={sel('monogram')} onDown={onPointerDownEl('monogram')} onMove={onPointerMove} onUp={endDrag} onResize={onPointerDownResize('monogram')}
                center style={{ left: px(layout.monogram.cx), top: px(layout.monogram.cy), width: px(layout.monogram.r * 2), height: px(layout.monogram.r * 2) }}>
                <div className="pointer-events-none absolute inset-0 rounded-full" style={{ border: `${Math.max(1, px(1.5))}px solid ${LIFESTYLE_COLORS.cream}`, opacity: 0.85 }} />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center" style={{ color: LIFESTYLE_COLORS.cream, fontFamily: LIFESTYLE_FONT.display, fontSize: px(layout.monogram.size), opacity: 0.9 }}>
                  {layout.monogram.letter}
                </div>
              </Movable>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg border border-white/20 py-2.5 text-[13px] text-white/80">বাতিল</button>
        <button type="button" disabled={busy} onClick={apply} className="flex-[2] rounded-lg bg-[#E07A5F] py-2.5 text-[13px] font-bold text-white disabled:opacity-50">
          {busy ? 'হচ্ছে…' : 'এভাবেই Final করুন ✅'}
        </button>
      </div>
    </div>
  )

  return createPortal(ui, document.body)
}

const r = (v: number) => Math.round(v)

/** Apply a move/resize gesture to the working layout, returning a new copy. */
function applyGesture(prev: LifestyleLayout, d: NonNullable<DragState>, dx: number, dy: number): LifestyleLayout {
  const delta = (dx + dy) / 2 // resize: diagonal drag, down/right = bigger
  switch (d.id) {
    // --- text blocks ---
    case 'eyebrow':
    case 'headline':
    case 'offer':
    case 'est': {
      const o = d.orig as LifestyleLayout['headline']
      const cur = prev[d.id]
      let updated: LifestyleLayout['headline']
      if (d.kind === 'move') {
        updated = { ...cur, x: o.x + dx, y: o.y + dy }
      } else {
        const ratio = clamp((o.size + delta * 0.5) / o.size, 0.3, 3)
        updated = { ...cur, size: clamp(o.size * ratio, 10, 160), leading: clamp(o.leading * ratio, 14, 200) }
      }
      const next = { ...prev }
      if (d.id === 'eyebrow') next.eyebrow = updated
      else if (d.id === 'headline') next.headline = updated
      else if (d.id === 'offer') next.offer = updated
      else next.est = updated
      return next
    }
    // --- code badge ---
    case 'codeBadge': {
      const o = d.orig as LifestyleLayout['codeBadge']
      if (d.kind === 'move') return { ...prev, codeBadge: { ...prev.codeBadge, cx: o.cx + dx, cy: o.cy + dy } }
      const ratio = clamp((o.r + delta * 0.5) / o.r, 0.4, 3)
      return { ...prev, codeBadge: { ...prev.codeBadge, r: clamp(o.r * ratio, 20, 160), size: clamp(o.size * ratio, 8, 80), labelSize: clamp(o.labelSize * ratio, 8, 60), labelDy: o.labelDy * ratio } }
    }
    // --- monogram ---
    case 'monogram': {
      const o = d.orig as LifestyleLayout['monogram']
      if (d.kind === 'move') return { ...prev, monogram: { ...prev.monogram, cx: o.cx + dx, cy: o.cy + dy } }
      const ratio = clamp((o.r + delta * 0.5) / o.r, 0.4, 3)
      return { ...prev, monogram: { ...prev.monogram, r: clamp(o.r * ratio, 8, 80), size: clamp(o.size * ratio, 8, 80) } }
    }
    // --- rule ---
    case 'rule': {
      const o = d.orig as LifestyleLayout['rule']
      if (d.kind === 'move') return { ...prev, rule: { ...prev.rule, x: o.x + dx, y: o.y + dy } }
      return { ...prev, rule: { ...prev.rule, w: clamp(o.w + delta, 10, 600) } }
    }
    // --- logo ---
    case 'logo': {
      const o = d.orig as LifestyleLayout['logo']
      if (d.kind === 'move') return { ...prev, logo: { ...prev.logo, x: o.x + dx, y: o.y + dy } }
      return { ...prev, logo: { ...prev.logo, w: clamp(o.w + delta, 60, 700) } }
    }
  }
  return prev
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---- presentational pieces ----------------------------------------------

type GestureProps = {
  onDown: (e: React.PointerEvent) => void
  onMove: (e: React.PointerEvent) => void
  onUp: () => void
  onResize: (e: React.PointerEvent) => void
  selected: boolean
}

function Movable({
  children, style, center, onDown, onMove, onUp, onResize, selected,
}: GestureProps & { children: React.ReactNode; style: React.CSSProperties; center?: boolean }) {
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="absolute"
      style={{ ...style, transform: center ? 'translate(-50%, -50%)' : undefined, outline: selected ? '1.5px dashed rgba(255,255,255,0.85)' : 'none', cursor: 'move' }}
    >
      {children}
      {selected && <ResizeHandle onDown={onResize} onMove={onMove} onUp={onUp} />}
    </div>
  )
}

function TextBlock({
  el, accent, scale, selected, onDown, onMove, onUp, onResize,
}: GestureProps & { el: LifestyleLayout['headline']; accent: string; scale: number }) {
  if (!el.lines.length) return null
  const px = (v: number) => v * scale
  const color = el.color === 'accent' ? accent : LIFESTYLE_COLORS.cream
  const fam = el.font === 'display' ? LIFESTYLE_FONT.display : LIFESTYLE_FONT.serif
  // anchor: x is the left/centre/right edge; top approximates the first baseline.
  const transform =
    el.justify === 'middle' ? 'translateX(-50%)' : el.justify === 'end' ? 'translateX(-100%)' : undefined
  const textAlign = el.justify === 'middle' ? 'center' : el.justify === 'end' ? 'right' : 'left'
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="absolute"
      style={{
        left: px(el.x),
        top: px(el.y - el.size * 0.8),
        transform,
        textAlign,
        color,
        fontFamily: fam,
        fontWeight: el.weight,
        fontSize: px(el.size),
        lineHeight: `${px(el.leading)}px`,
        letterSpacing: el.letterSpacing ? px(el.letterSpacing) : undefined,
        whiteSpace: 'nowrap',
        cursor: 'move',
        outline: selected ? '1.5px dashed rgba(255,255,255,0.85)' : 'none',
      }}
    >
      {el.lines.map((ln, i) => (
        <div key={i}>{ln}</div>
      ))}
      {selected && <ResizeHandle onDown={onResize} onMove={onMove} onUp={onUp} />}
    </div>
  )
}

function ResizeHandle({ onDown, onMove, onUp }: { onDown: (e: React.PointerEvent) => void; onMove: (e: React.PointerEvent) => void; onUp: () => void }) {
  return (
    <div
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="absolute -bottom-2.5 -right-2.5 h-5 w-5 rounded-full border-2 border-white bg-[#E07A5F]"
      style={{ cursor: 'nwse-resize', touchAction: 'none' }}
    />
  )
}

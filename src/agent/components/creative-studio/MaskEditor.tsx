'use client'

/**
 * CS7 — FLUX Fill mask editor.
 *
 * Paint WHERE to edit (white = edit, black = keep — the locked contract in
 * mask-contract.ts). Brush / erase / undo / clear / invert / size / feather /
 * preview toggle, works with mouse and touch (pointer events). The mask is
 * exported at the image's NATURAL dimensions so it always matches the base
 * pixel-for-pixel; the upload route re-validates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { toast } from 'react-hot-toast'
import { cn } from '@/lib/utils'
import {
  MASK_PRESETS,
  estimateFluxFillCostUsd,
  featherRadiusPx,
  getMaskPreset,
  type MaskPresetId,
} from '@/lib/creative-studio/mask-contract'

const MAX_UNDO = 20

export type MaskEditorResult = {
  maskBlob: Blob
  preset: MaskPresetId
  detail: string
  width: number
  height: number
}

export default function MaskEditor({
  imageUrl,
  onCancel,
  onRun,
  running,
}: {
  /** signed/object URL of the base image */
  imageUrl: string
  onCancel: () => void
  /** owner confirmed — hand back the exported mask + preset + prompt detail */
  onRun: (result: MaskEditorResult) => void
  running: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [brush, setBrush] = useState(36)
  const [erasing, setErasing] = useState(false)
  const [feather, setFeather] = useState<'none' | 'soft' | 'wide'>('soft')
  const [preset, setPreset] = useState<MaskPresetId>('replace_background')
  const [detail, setDetail] = useState('')
  const [showMask, setShowMask] = useState(true)
  const [hasStrokes, setHasStrokes] = useState(false)
  const undoStack = useRef<ImageData[]>([])
  const drawing = useRef(false)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  // Load the base image to learn its natural dimensions.
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => toast.error('ছবি লোড হয়নি — আবার চেষ্টা করুন')
    img.src = imageUrl
  }, [imageUrl])

  // The paint canvas runs at natural resolution; CSS scales it to fit.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imgSize) return
    canvas.width = imgSize.w
    canvas.height = imgSize.h
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.clearRect(0, 0, imgSize.w, imgSize.h)
    undoStack.current = []
    setHasStrokes(false)
  }, [imgSize])

  const pushUndo = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !imgSize) return
    undoStack.current.push(ctx.getImageData(0, 0, imgSize.w, imgSize.h))
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift()
  }, [imgSize])

  const canvasPoint = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }, [])

  const strokeTo = useCallback(
    (p: { x: number; y: number }) => {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return
      // Scale the on-screen brush size up to natural-resolution pixels.
      const rect = canvasRef.current!.getBoundingClientRect()
      const scale = canvasRef.current!.width / rect.width
      ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over'
      ctx.strokeStyle = 'rgba(255,255,255,1)'
      ctx.fillStyle = 'rgba(255,255,255,1)'
      ctx.lineWidth = brush * scale
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const from = lastPoint.current ?? p
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      lastPoint.current = p
    },
    [brush, erasing],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pushUndo()
    drawing.current = true
    lastPoint.current = null
    strokeTo(canvasPoint(e))
    setHasStrokes(true)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing.current) return
    e.preventDefault()
    strokeTo(canvasPoint(e))
  }
  const onPointerUp = () => {
    drawing.current = false
    lastPoint.current = null
  }

  const undo = () => {
    const ctx = canvasRef.current?.getContext('2d')
    const prev = undoStack.current.pop()
    if (!ctx || !imgSize) return
    if (prev) ctx.putImageData(prev, 0, 0)
    else ctx.clearRect(0, 0, imgSize.w, imgSize.h)
  }
  const clearAll = () => {
    pushUndo()
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && imgSize) ctx.clearRect(0, 0, imgSize.w, imgSize.h)
    setHasStrokes(false)
  }
  const invert = () => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !imgSize) return
    pushUndo()
    const data = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
    const px = data.data
    for (let i = 0; i < px.length; i += 4) {
      const painted = px[i + 3] >= 128
      px[i] = 255
      px[i + 1] = 255
      px[i + 2] = 255
      px[i + 3] = painted ? 0 : 255
    }
    ctx.putImageData(data, 0, 0)
    setHasStrokes(true)
  }

  /** Export: black background + painted strokes as white, feathered, natural size. */
  const exportMask = useCallback(async (): Promise<Blob | null> => {
    const canvas = canvasRef.current
    if (!canvas || !imgSize) return null
    const out = document.createElement('canvas')
    out.width = imgSize.w
    out.height = imgSize.h
    const ctx = out.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    const radius = featherRadiusPx(Math.max(imgSize.w, imgSize.h), feather)
    if (radius > 0) ctx.filter = `blur(${radius}px)`
    ctx.drawImage(canvas, 0, 0)
    ctx.filter = 'none'
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'))
  }, [imgSize, feather])

  const estCost = imgSize ? estimateFluxFillCostUsd(imgSize.w, imgSize.h) : null
  const presetDef = useMemo(() => getMaskPreset(preset), [preset])

  const handleRun = async () => {
    if (!hasStrokes) {
      toast.error('আগে ব্রাশ দিয়ে মাস্ক আঁকুন')
      return
    }
    if (preset === 'custom' && !detail.trim()) {
      toast.error('নিজের প্রম্পট লিখুন — কী বদলাতে চান')
      return
    }
    const blob = await exportMask()
    if (!blob || !imgSize) {
      toast.error('মাস্ক তৈরি হয়নি — আবার চেষ্টা করুন')
      return
    }
    onRun({ maskBlob: blob, preset, detail: detail.trim(), width: imgSize.w, height: imgSize.h })
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex flex-col bg-black/95"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <p className="text-[14px] font-bold text-white">🎯 Precision Edit — মাস্ক আঁকুন</p>
        <button
          type="button"
          onClick={onCancel}
          className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/20"
          aria-label="বন্ধ করুন"
        >
          ✕
        </button>
      </div>

      {/* canvas area */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3">
        <div className="relative max-h-full max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="" className="max-h-[58vh] max-w-full select-none rounded-lg" draggable={false} />
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className={cn(
              'absolute inset-0 h-full w-full cursor-crosshair rounded-lg touch-none',
              showMask ? 'opacity-60' : 'opacity-0',
            )}
            style={{ mixBlendMode: 'normal', filter: 'drop-shadow(0 0 0 rgba(224,122,95,1))' }}
          />
          {/* red tint preview of painted area */}
          {showMask && (
            <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] text-white/90">
              সাদা-আঁকা জায়গাই বদলাবে · {presetDef.hintBn}
            </div>
          )}
        </div>
      </div>

      {/* tools */}
      <div className="shrink-0 space-y-2 px-4 pb-3 pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setErasing(false)}
            className={cn('rounded-full px-3 py-1.5 text-[11px] font-semibold', !erasing ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-white/80')}
          >
            🖌 ব্রাশ
          </button>
          <button
            type="button"
            onClick={() => setErasing(true)}
            className={cn('rounded-full px-3 py-1.5 text-[11px] font-semibold', erasing ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-white/80')}
          >
            🧽 মুছুন
          </button>
          <button type="button" onClick={undo} className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80">
            ↩ Undo
          </button>
          <button type="button" onClick={clearAll} className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80">
            🗑 Clear
          </button>
          <button type="button" onClick={invert} className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80">
            🔄 Invert
          </button>
          <button
            type="button"
            onClick={() => setShowMask((v) => !v)}
            className="rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-semibold text-white/80"
          >
            {showMask ? '👁 মাস্ক লুকাও' : '👁 মাস্ক দেখাও'}
          </button>
          <label className="ml-1 flex items-center gap-1.5 text-[11px] text-white/80">
            সাইজ
            <input
              type="range"
              min={8}
              max={120}
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
              className="w-24 accent-[#E07A5F]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-white/80">
            ফেদার
            <select
              value={feather}
              onChange={(e) => setFeather(e.target.value as typeof feather)}
              className="rounded-md bg-white/10 px-2 py-1 text-[11px] text-white"
            >
              <option value="none">নেই</option>
              <option value="soft">নরম</option>
              <option value="wide">চওড়া</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {MASK_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={cn(
                'rounded-full px-2.5 py-1 text-[10.5px] font-semibold',
                preset === p.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-white/80',
              )}
            >
              {p.labelBn}
            </button>
          ))}
        </div>

        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={preset === 'custom' ? 'কী বদলাতে চান লিখুন (আবশ্যক)…' : 'বাড়তি নির্দেশ (ঐচ্ছিক)…'}
          className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/40 focus:border-[#E07A5F]/60"
        />

        <button
          type="button"
          disabled={running}
          onClick={() => void handleRun()}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-xl py-3 text-[13.5px] font-bold text-white',
            running ? 'bg-[#94A3B8]' : 'bg-[#E07A5F]',
          )}
        >
          {running ? (
            <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> পাঠানো হচ্ছে…</>
          ) : (
            <>Run — FLUX Fill{estCost !== null ? ` · আনুমানিক $${estCost.toFixed(2)}` : ''}</>
          )}
        </button>
        <p className="text-center text-[10px] text-white/50">
          শুধু মাস্ক-করা জায়গা বদলাবে — মুখ/গার্মেন্টের বাকি পিক্সেল অপরিবর্তিত থাকবে
        </p>
      </div>
    </motion.div>
  )
}

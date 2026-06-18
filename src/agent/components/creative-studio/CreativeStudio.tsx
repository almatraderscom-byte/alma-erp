'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { Toaster, toast } from 'react-hot-toast'
import { cn } from '@/lib/utils'
import {
  STUDIO_MODES,
  FAMILY_PRESETS,
  ASPECT_RATIOS,
  RESOLUTIONS,
  GEN_MODES,
  BACKGROUND_PRESETS,
  VIDEO_VIBES,
  type StudioModeId,
  type StudioProvider,
  type FamilyPresetId,
} from '@/lib/creative-studio/constants'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import {
  fetchStudioConfig,
  fetchGallery,
  fetchModels,
  runStudioJob,
  saveModel,
  uploadStudioFile,
  type GalleryItem,
  type StudioConfig,
} from '@/agent/components/creative-studio/studio-api'

type MainView = 'studio' | 'gallery' | 'models'

export default function CreativeStudio() {
  const [view, setView] = useState<MainView>('studio')
  const [config, setConfig] = useState<StudioConfig | null>(null)

  useEffect(() => {
    void fetchStudioConfig().then(setConfig).catch(() => {})
  }, [])

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] w-full overflow-hidden bg-transparent text-cream">
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />
      {/* Desktop sidebar */}
      <aside className="hidden w-[72px] shrink-0 flex-col items-center border-r border-border-subtle bg-card/70 backdrop-blur-xl py-4 md:flex">
        <NavIcon href="/agent" label="Chat" active={false}>
          <ChatSvg />
        </NavIcon>
        <NavIcon label="Studio" active={view === 'studio'} onClick={() => setView('studio')}>
          <StudioSvg />
        </NavIcon>
        <NavIcon label="Gallery" active={view === 'gallery'} onClick={() => setView('gallery')}>
          <GallerySvg />
        </NavIcon>
        <NavIcon label="Models" active={view === 'models'} onClick={() => setView('models')}>
          <UserSvg />
        </NavIcon>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card/75 backdrop-blur-xl px-3 py-2.5 backdrop-blur-md sm:px-4">
          <div>
            <p className="text-sm font-bold text-cream">Creative Studio</p>
            <p className="text-[10px] text-muted">{config?.organization ?? 'Alma Traders'}</p>
          </div>
          <div className="flex items-center gap-2">
            {config && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  config.fashnConfigured ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-amber-100 text-amber-800',
                )}
              >
                {config.fashnConfigured ? 'FASHN Pro ready' : 'Add FASHN_API_KEY'}
              </span>
            )}
            <Link
              href="/agent"
              className="rounded-lg bg-[#E07A5F] px-2.5 py-1.5 text-[11px] font-semibold text-white md:hidden"
            >
              Chat
            </Link>
          </div>
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {view === 'studio' && (
              <motion.div key="studio" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <StudioWorkspace config={config} onOpenGallery={() => setView('gallery')} />
              </motion.div>
            )}
            {view === 'gallery' && (
              <motion.div key="gallery" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <GalleryView />
              </motion.div>
            )}
            {view === 'models' && (
              <motion.div key="models" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <ModelsView />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Mobile bottom nav */}
        <nav
          className="flex shrink-0 border-t border-border-subtle bg-card/60 backdrop-blur-2xl md:hidden"
          style={{ paddingBottom: 'max(0.35rem, env(safe-area-inset-bottom))' }}
        >
          {(
            [
              ['studio', 'Studio', StudioSvg],
              ['gallery', 'Gallery', GallerySvg],
              ['models', 'Models', UserSvg],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium',
                view === id ? 'text-[#E07A5F]' : 'text-muted',
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}

function NavIcon({
  label,
  active,
  onClick,
  href,
  children,
}: {
  label: string
  active: boolean
  onClick?: () => void
  href?: string
  children: React.ReactNode
}) {
  const cls = cn(
    'mb-3 flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-[9px] font-medium transition-colors',
    active ? 'bg-[#E07A5F]/12 text-[#E07A5F]' : 'text-muted hover:text-muted',
  )
  if (href) {
    return (
      <Link href={href} className={cls}>
        {children}
        {label}
      </Link>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
      {label}
    </button>
  )
}

function StudioWorkspace({
  config,
  onOpenGallery,
}: {
  config: StudioConfig | null
  onOpenGallery: () => void
}) {
  const [mode, setMode] = useState<StudioModeId>('product_to_model')
  const [provider, setProvider] = useState<StudioProvider>('fashn')
  const [familyPreset, setFamilyPreset] = useState<FamilyPresetId>('single')
  const [productPreview, setProductPreview] = useState<string | null>(null)
  const [modelPreview, setModelPreview] = useState<string | null>(null)
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [productPath, setProductPath] = useState<string | null>(null)
  const [modelPath, setModelPath] = useState<string | null>(null)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  const [models, setModels] = useState<Array<{ id: string; name: string; role: string | null }>>([])
  const [prompt, setPrompt] = useState('')
  const [backgroundId, setBackgroundId] = useState('studio')
  const [aspectRatio, setAspectRatio] = useState('4:5')
  const [resolution, setResolution] = useState<FashnResolution>('2k')
  const [genMode, setGenMode] = useState<FashnGenerationMode>('balanced')
  const [numImages, setNumImages] = useState(1)
  const [durationSec, setDurationSec] = useState(6)
  const [vibe, setVibe] = useState<'premium' | 'festival' | 'offer' | 'lifestyle'>('premium')
  const [running, setRunning] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)

  const modeDef = useMemo(() => STUDIO_MODES.find((m) => m.id === mode)!, [mode])
  const bgPrompt = BACKGROUND_PRESETS.find((b) => b.id === backgroundId)?.prompt ?? ''

  useEffect(() => {
    void fetchModels()
      .then((d) => setModels(d.models ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (config?.fashnConfigured && mode !== 'image_to_video') setProvider('fashn')
    else if (mode === 'image_to_video') setProvider('gemini')
    else setProvider('gemini')
  }, [config, mode])

  const upload = async (file: File, kind: 'product' | 'model' | 'source') => {
    const path = await uploadStudioFile(file, `studio-${kind}`)
    const url = URL.createObjectURL(file)
    if (kind === 'product') {
      if (productPreview) URL.revokeObjectURL(productPreview)
      setProductPreview(url)
      setProductPath(path)
    } else if (kind === 'model') {
      if (modelPreview) URL.revokeObjectURL(modelPreview)
      setModelPreview(url)
      setModelPath(path)
    } else {
      if (sourcePreview) URL.revokeObjectURL(sourcePreview)
      setSourcePreview(url)
      setSourcePath(path)
    }
  }

  const canRun = useMemo(() => {
    if (mode === 'image_to_video') return Boolean(sourcePath || productPath || modelPath)
    if (modeDef.needsProduct && !productPath) return false
    if (modeDef.needsModel && !modelPath && !modelId) return false
    if (modeDef.needsSource && !sourcePath) return false
    return true
  }, [mode, modeDef, productPath, modelPath, modelId, sourcePath])

  const handleRun = async () => {
    if (!canRun) {
      toast.error('Required images missing')
      return
    }
    setRunning(true)
    try {
      const result = await runStudioJob({
        mode,
        provider,
        productImagePath: productPath ?? undefined,
        modelImagePath: modelPath ?? undefined,
        sourceImagePath: sourcePath ?? productPath ?? modelPath ?? undefined,
        modelId: modelId || undefined,
        familyPreset: mode === 'product_to_model' || mode === 'try_on' ? familyPreset : undefined,
        prompt,
        backgroundPrompt: backgroundId !== 'custom' ? bgPrompt : prompt,
        aspectRatio,
        resolution,
        generationMode: genMode,
        numImages,
        durationSec,
        vibe,
      })
      toast.success(result.message)
      onOpenGallery()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Canvas / drop zone */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-3 pt-3', panelOpen ? 'pb-[min(58vh,480px)] md:pb-[min(52vh,420px)]' : 'pb-28 md:pb-20')}>
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          <UploadTile
            label={modeDef.needsProduct ? 'Product / mannequin' : 'Product (optional)'}
            preview={productPreview}
            onFile={(f) => void upload(f, 'product').catch((e) => toast.error(String(e)))}
            required={modeDef.needsProduct}
          />
          {(modeDef.needsModel || mode === 'try_on') && (
            <UploadTile
              label="Model photo"
              preview={modelPreview}
              onFile={(f) => void upload(f, 'model').catch((e) => toast.error(String(e)))}
              required={modeDef.needsModel}
            />
          )}
          {modeDef.needsSource && (
            <UploadTile
              label={mode === 'image_to_video' ? 'Source image for reel' : 'Source image'}
              preview={sourcePreview}
              onFile={(f) => void upload(f, 'source').catch((e) => toast.error(String(e)))}
              required
            />
          )}

          {models.length > 0 && (
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full rounded-xl border border-border bg-card/60 backdrop-blur-2xl px-3 py-2.5 text-sm"
            >
              <option value="">Saved model (optional)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.role})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Bottom control dock — FASHN-style */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-[52px] z-20 border-t border-border bg-card/80 shadow-[0_-8px_30px_rgba(0,0,0,0.3)] backdrop-blur-2xl md:bottom-0',
        )}
        style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
      >
        <button
          type="button"
          onClick={() => setPanelOpen((o) => !o)}
          className="flex w-full items-center justify-center py-1 text-muted"
        >
          <span className="h-1 w-10 rounded-full bg-white/15" />
        </button>

        {panelOpen && (
          <div className="max-h-[min(50vh,400px)] overflow-y-auto px-3 pb-3">
            {/* Mode chips */}
            <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {STUDIO_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all',
                    mode === m.id ? 'bg-gold/20 border border-gold/30 text-cream shadow-sm' : 'bg-white/[0.05] text-muted',
                  )}
                >
                  {m.short}
                </button>
              ))}
            </div>

            {/* Family presets */}
            {(mode === 'product_to_model' || mode === 'try_on') && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {FAMILY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setFamilyPreset(p.id)}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[10px] font-semibold',
                      familyPreset === p.id ? 'bg-[#E07A5F] text-white' : 'border border-border bg-card/60 backdrop-blur-2xl',
                    )}
                  >
                    {p.labelBn}
                  </button>
                ))}
              </div>
            )}

            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Optional: Blonde hair, studio photoshoot, festive mood…"
              className="mb-2 w-full rounded-xl border border-border bg-bg-1 text-cream px-3 py-2 text-[13px] outline-none focus:border-[#E07A5F]/40"
            />

            <div className="mb-2 flex flex-wrap gap-1.5">
              {mode !== 'image_to_video' && (
                <>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as StudioProvider)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    <option value="fashn" disabled={!config?.fashnConfigured}>
                      Pro (FASHN)
                    </option>
                    <option value="gemini">Draft (Gemini)</option>
                  </select>
                  <select
                    value={backgroundId}
                    onChange={(e) => setBackgroundId(e.target.value)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {BACKGROUND_PRESETS.map((b) => (
                      <option key={b.id} value={b.id}>
                        BG: {b.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {ASPECT_RATIOS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value as FashnResolution)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {RESOLUTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r.toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <select
                    value={genMode}
                    onChange={(e) => setGenMode(e.target.value as FashnGenerationMode)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {GEN_MODES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center rounded-lg border border-border bg-card/60 backdrop-blur-2xl">
                    <button type="button" className="px-2 py-1.5 text-[11px]" onClick={() => setNumImages((n) => Math.max(1, n - 1))}>
                      −
                    </button>
                    <span className="min-w-[1.5rem] text-center text-[11px] font-bold">{numImages}</span>
                    <button type="button" className="px-2 py-1.5 text-[11px]" onClick={() => setNumImages((n) => Math.min(4, n + 1))}>
                      +
                    </button>
                  </div>
                </>
              )}
              {mode === 'image_to_video' && (
                <>
                  <select
                    value={vibe}
                    onChange={(e) => setVibe(e.target.value as typeof vibe)}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {VIDEO_VIBES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={durationSec}
                    onChange={(e) => setDurationSec(Number(e.target.value))}
                    className="rounded-lg border border-border bg-card/60 backdrop-blur-2xl px-2 py-1.5 text-[11px]"
                  >
                    {[4, 5, 6, 7, 8].map((s) => (
                      <option key={s} value={s}>
                        {s}s reel
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            <motion.button
              type="button"
              disabled={!canRun || running}
              whileTap={{ scale: 0.98 }}
              onClick={() => void handleRun()}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-bold text-white transition-opacity',
                canRun && !running ? 'bg-[#1a1a2e]' : 'bg-[#94A3B8]',
              )}
            >
              {running ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Generating…
                </>
              ) : (
                <>Run — {provider === 'fashn' ? 'FASHN Pro' : 'Gemini Draft'}</>
              )}
            </motion.button>
            <p className="mt-1.5 text-center text-[10px] text-muted">No LLM cost — direct render queue</p>
          </div>
        )}
      </div>
    </div>
  )
}

function UploadTile({
  label,
  preview,
  onFile,
  required,
}: {
  label: string
  preview: string | null
  onFile: (f: File) => void
  required?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => e.key === 'Enter' && ref.current?.click()}
      className={cn(
        'overflow-hidden rounded-2xl border-2 border-dashed transition-colors',
        preview ? 'border-[#E07A5F]/25 bg-card/60 backdrop-blur-2xl' : 'border-border bg-card/60 backdrop-blur-xl',
      )}
    >
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={label} className="mx-auto max-h-44 w-full object-contain p-2" />
      ) : (
        <div className="px-4 py-8 text-center">
          <p className="text-sm font-semibold text-muted">
            {label}
            {required && <span className="text-[#E07A5F]"> *</span>}
          </p>
          <p className="mt-1 text-[11px] text-muted">Tap to upload or drop image</p>
        </div>
      )}
    </div>
  )
}

function GalleryView() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const data = await fetchGallery(1)
      setItems(data.items)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(t)
  }, [load])

  return (
    <div className="px-3 py-3 pb-20 md:pb-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold">Library</h2>
        <button type="button" onClick={() => void load()} className="text-[11px] font-semibold text-[#E07A5F]">
          Refresh
        </button>
      </div>
      {loading && items.length === 0 ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No generations yet — Studio থেকে Run করুন।</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="overflow-hidden rounded-xl border border-border-subtle bg-card/60 backdrop-blur-2xl shadow-sm"
            >
              <div className="relative aspect-[4/5] bg-bg-1">
                {item.previewUrl ? (
                  item.storagePath?.endsWith('.mp4') || item.type === 'video_gen' ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={item.previewUrl} className="h-full w-full object-cover" controls playsInline />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                  )
                ) : (
                  <div className="flex h-full items-center justify-center p-2 text-center text-[10px] text-muted">
                    {item.status === 'approved' || item.status === 'pending'
                      ? 'Rendering…'
                      : item.status}
                  </div>
                )}
                <span
                  className={cn(
                    'absolute left-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase',
                    item.status === 'executed' ? 'bg-[#81B29A]/90 text-white' : 'bg-black/50 text-white',
                  )}
                >
                  {item.provider}
                </span>
              </div>
              <div className="p-2">
                <p className="truncate text-[10px] font-semibold">{item.mode}</p>
                <p className="text-[9px] text-muted">{new Date(item.createdAt).toLocaleString('en-BD')}</p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelsView() {
  const [models, setModels] = useState<Array<{ id: string; name: string; role: string | null; isDefault: boolean }>>([])
  const [name, setName] = useState('')
  const [role, setRole] = useState('single')
  const [preview, setPreview] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const d = await fetchModels()
    setModels(d.models ?? [])
  }, [])

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  const onSave = async () => {
    if (!name.trim() || !path) {
      toast.error('Name + photo required')
      return
    }
    setSaving(true)
    try {
      await saveModel({
        id: name.trim().toLowerCase().replace(/\s+/g, '-'),
        name: name.trim(),
        imagePath: path,
        role,
      })
      toast.success(`Model "${name}" saved — chat এ "Model ${name}" বলুন`)
      setName('')
      setPath(null)
      if (preview) URL.revokeObjectURL(preview)
      setPreview(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg px-3 py-4 pb-8">
      <h2 className="mb-1 text-sm font-bold">Model Library</h2>
      <p className="mb-3 text-[11px] leading-snug text-muted">
        Full-body photo save করুন। Chat: &quot;Model Maruf use koro&quot; — agent মনে রাখবে।
      </p>

      <div
        className="mb-3 overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/60 backdrop-blur-2xl"
        onClick={() => ref.current?.click()}
      >
        <input
          ref={ref}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            if (preview) URL.revokeObjectURL(preview)
            setPreview(URL.createObjectURL(f))
            void uploadStudioFile(f, 'model-library')
              .then(setPath)
              .catch((err) => toast.error(String(err)))
          }}
        />
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Model" className="mx-auto max-h-52 object-contain p-2" />
        ) : (
          <p className="py-10 text-center text-sm text-muted">Upload model photo</p>
        )}
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name (e.g. Maruf)"
          className="rounded-xl border border-border px-3 py-2.5 text-sm"
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="rounded-xl border border-border px-3 py-2.5 text-sm">
          <option value="single">Single / Owner</option>
          <option value="father">Father</option>
          <option value="mother">Mother</option>
          <option value="son">Son (5–12)</option>
          <option value="daughter">Daughter (5–10)</option>
        </select>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void onSave()}
        className="mb-6 w-full rounded-xl bg-[#E07A5F] py-3 text-sm font-bold text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save to agent memory'}
      </button>

      <div className="space-y-2">
        {models.map((m) => (
          <div key={m.id} className="flex items-center justify-between rounded-xl border border-border-subtle bg-card/60 backdrop-blur-2xl px-3 py-2.5">
            <div>
              <p className="font-semibold">{m.name}</p>
              <p className="text-[10px] text-muted">{m.role}{m.isDefault ? ' · default' : ''}</p>
            </div>
            <code className="text-[9px] text-muted">{m.id}</code>
          </div>
        ))}
      </div>
    </div>
  )
}

function ChatSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function StudioSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M3 9h18" />
    </svg>
  )
}
function GallerySvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  )
}
function UserSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  )
}

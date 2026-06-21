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
  runAutoStudioJob,
  runStudioJob,
  saveModel,
  uploadStudioFile,
  fetchBranding,
  saveBranding,
  type GalleryItem,
  type StudioConfig,
  type BrandingConfig,
} from '@/agent/components/creative-studio/studio-api'

type MainView = 'studio' | 'gallery' | 'models' | 'branding'
type StudioModel = { id: string; name: string; role: string | null; isDefault: boolean }

export default function CreativeStudio() {
  const [view, setView] = useState<MainView>('studio')
  const [config, setConfig] = useState<StudioConfig | null>(null)

  useEffect(() => {
    void fetchStudioConfig().then(setConfig).catch(() => {})
  }, [])

  // The agent bottom-nav is hidden on this route (AgentBottomNav returns null),
  // so reclaim the 3.5rem the layout reserves for it: make .agent-main-height
  // fill the whole viewport here. Studio renders its own header (safe-top) and
  // its own bottom nav (safe-bottom), so it owns the full screen.
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('cs-fullscreen')
    return () => root.classList.remove('cs-fullscreen')
  }, [])

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-transparent text-cream">
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />
      {/* Desktop sidebar */}
      <aside className="hidden w-[72px] shrink-0 flex-col items-center border-r border-border-subtle bg-card/82 py-4 md:flex">
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
        <NavIcon label="Branding" active={view === 'branding'} onClick={() => setView('branding')}>
          <BrandingSvg />
        </NavIcon>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card/85 px-3 pb-2.5 backdrop-blur-md sm:px-4"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
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
            {view === 'branding' && (
              <motion.div key="branding" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <BrandingView />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Mobile bottom nav */}
        <nav
          className="flex shrink-0 border-t border-border-subtle bg-card/80 md:hidden"
          style={{ paddingBottom: 'max(0.35rem, env(safe-area-inset-bottom))' }}
        >
          {(
            [
              ['studio', 'Studio', StudioSvg],
              ['gallery', 'Gallery', GallerySvg],
              ['models', 'Models', UserSvg],
              ['branding', 'Branding', BrandingSvg],
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
  const [models, setModels] = useState<StudioModel[]>([])
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
  const [tab, setTab] = useState<'auto' | 'advanced'>('auto')
  const [includeFamily, setIncludeFamily] = useState(false)
  const [includeReel, setIncludeReel] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)

  const modeDef = useMemo(() => STUDIO_MODES.find((m) => m.id === mode)!, [mode])
  const bgPrompt = BACKGROUND_PRESETS.find((b) => b.id === backgroundId)?.prompt ?? ''

  const defaultModel = useMemo(
    () => models.find((m) => m.isDefault) ?? models[0] ?? null,
    [models],
  )
  const familyAvailable = useMemo(() => {
    const roles = new Set(models.map((m) => m.role))
    return (roles.has('father') && roles.has('son'))
      || (roles.has('mother') && roles.has('son'))
      || (roles.has('mother') && roles.has('daughter'))
  }, [models])

  useEffect(() => {
    void fetchModels()
      .then((d) => setModels(d.models ?? []))
      .catch(() => {})
  }, [])

  const handleAutoRun = async () => {
    if (!productPath) {
      toast.error('Product ছবি upload করুন')
      return
    }
    if (!defaultModel) {
      toast.error('প্রথমে Models ট্যাবে একটি মডেল সেভ করুন')
      return
    }
    setAutoRunning(true)
    try {
      const result = await runAutoStudioJob({
        productImagePath: productPath,
        includeFamily: includeFamily && familyAvailable,
        includeReel,
      })
      toast.success(result.message)
      onOpenGallery()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setAutoRunning(false)
    }
  }

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
      {/* Auto / Advanced switch */}
      <div className="flex shrink-0 gap-1.5 px-3 pb-1 pt-2.5">
        {(['auto', 'advanced'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded-xl py-2 text-[12px] font-bold transition-colors',
              tab === t ? 'bg-[#E07A5F] text-white shadow-sm' : 'border border-border bg-card/70 text-muted',
            )}
          >
            {t === 'auto' ? '✨ Auto — এক ট্যাপ' : '⚙ Advanced'}
          </button>
        ))}
      </div>

      {tab === 'auto' && (
        <AutoPanel
          productPreview={productPreview}
          onProduct={(f) => void upload(f, 'product').catch((e) => toast.error(String(e)))}
          defaultModel={defaultModel}
          familyAvailable={familyAvailable}
          includeFamily={includeFamily}
          setIncludeFamily={setIncludeFamily}
          includeReel={includeReel}
          setIncludeReel={setIncludeReel}
          bestRealism={Boolean(config?.fashnConfigured)}
          running={autoRunning}
          canRun={Boolean(productPath && defaultModel)}
          onRun={() => void handleAutoRun()}
        />
      )}

      {tab === 'advanced' && (
      <>
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
              className="w-full rounded-xl border border-border bg-card/80 px-3 py-2.5 text-sm"
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
          'absolute inset-x-0 bottom-[52px] z-20 border-t border-border bg-card/80 shadow-[0_-8px_30px_rgba(0,0,0,0.3)] md:bottom-0',
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
                      familyPreset === p.id ? 'bg-[#E07A5F] text-white' : 'border border-border bg-card/80',
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                  >
                    <option value="fashn" disabled={!config?.fashnConfigured}>
                      Pro (FASHN)
                    </option>
                    <option value="gemini">Draft (Gemini)</option>
                  </select>
                  <select
                    value={backgroundId}
                    onChange={(e) => setBackgroundId(e.target.value)}
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                  >
                    {GEN_MODES.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center rounded-lg border border-border bg-card/80">
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
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
                    className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
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
      </>
      )}
    </div>
  )
}

function AutoPanel({
  productPreview,
  onProduct,
  defaultModel,
  familyAvailable,
  includeFamily,
  setIncludeFamily,
  includeReel,
  setIncludeReel,
  bestRealism,
  running,
  canRun,
  onRun,
}: {
  productPreview: string | null
  onProduct: (f: File) => void
  defaultModel: StudioModel | null
  familyAvailable: boolean
  includeFamily: boolean
  setIncludeFamily: (v: boolean) => void
  includeReel: boolean
  setIncludeReel: (v: boolean) => void
  bestRealism: boolean
  running: boolean
  canRun: boolean
  onRun: () => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-4">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="text-center">
          <p className="text-[15px] font-bold text-cream">Product দিন — বাকিটা AI করবে</p>
          <p className="mt-1 text-[12px] leading-snug text-muted">
            শুধু পণ্যের ছবি upload করুন। সেভ করা মডেল, prompt, ব্যাকগ্রাউন্ড — সব AI নিজেই ঠিক রাখবে।
          </p>
        </div>

        <UploadTile
          label="Product ছবি"
          preview={productPreview}
          onFile={onProduct}
          required
        />

        {/* Default model status */}
        {defaultModel ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/70 px-3.5 py-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#E07A5F]/12 text-[#E07A5F]">
              <UserSvg className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-cream">মডেল: {defaultModel.name}</p>
              <p className="text-[10px] text-muted">
                {bestRealism
                  ? '🟢 FASHN — best realism engine চালু · Models ট্যাবে বদলানো যাবে'
                  : 'Gemini engine · FASHN_API_KEY দিলে best realism পাবেন'}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-400/40 bg-amber-50/10 px-3.5 py-3 text-[12px] text-amber-700">
            ⚠ এখনো কোনো মডেল সেভ করা নেই। নিচের <b>Models</b> ট্যাবে গিয়ে একটি মডেলের ছবি সেভ করুন — তারপর শুধু product দিলেই হবে।
          </div>
        )}

        {/* Family toggle */}
        {familyAvailable && (
          <button
            type="button"
            onClick={() => setIncludeFamily(!includeFamily)}
            className={cn(
              'flex items-center justify-between rounded-2xl border px-3.5 py-3 text-left transition-colors',
              includeFamily ? 'border-[#E07A5F]/40 bg-[#E07A5F]/8' : 'border-border-subtle bg-card/70',
            )}
          >
            <div>
              <p className="text-[13px] font-semibold text-cream">পরিবার ভ্যারিয়েন্টও বানাও</p>
              <p className="text-[10px] text-muted">বাবা+ছেলে / মা+মেয়ে — যাদের মডেল সেভ আছে</p>
            </div>
            <span
              className={cn(
                'relative h-6 w-10 shrink-0 rounded-full transition-colors',
                includeFamily ? 'bg-[#E07A5F]' : 'bg-white/15',
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
                  includeFamily ? 'left-[1.125rem]' : 'left-0.5',
                )}
              />
            </span>
          </button>
        )}

        {/* Reel toggle (Phase 4 — Veo 3.1 video) */}
        <button
          type="button"
          onClick={() => setIncludeReel(!includeReel)}
          className={cn(
            'flex items-center justify-between rounded-2xl border px-3.5 py-3 text-left transition-colors',
            includeReel ? 'border-[#E07A5F]/40 bg-[#E07A5F]/8' : 'border-border-subtle bg-card/70',
          )}
        >
          <div>
            <p className="text-[13px] font-semibold text-cream">🎬 ছোট রিলও বানাও</p>
            <p className="text-[10px] text-muted">৬ সেকেন্ড 9:16 প্রোডাক্ট রিল (Veo 3.1) · আলাদা খরচ</p>
          </div>
          <span
            className={cn(
              'relative h-6 w-10 shrink-0 rounded-full transition-colors',
              includeReel ? 'bg-[#E07A5F]' : 'bg-white/15',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all',
                includeReel ? 'left-[1.125rem]' : 'left-0.5',
              )}
            />
          </span>
        </button>

        <motion.button
          type="button"
          disabled={!canRun || running}
          whileTap={{ scale: 0.98 }}
          onClick={onRun}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-bold text-white transition-opacity',
            canRun && !running ? 'bg-[#E07A5F]' : 'bg-[#94A3B8]',
          )}
        >
          {running ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              তৈরি হচ্ছে…
            </>
          ) : (
            <>✨ Generate</>
          )}
        </motion.button>
        <p className="text-center text-[10px] text-muted">
          No LLM cost · ছবি render queue{includeReel ? ' · রিলে আলাদা ভিডিও খরচ' : ''}
        </p>
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
        preview ? 'border-[#E07A5F]/25 bg-card/80' : 'border-border bg-card/80',
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

const isPendingStatus = (s: string) => s === 'approved' || s === 'pending' || s === 'processing'
const isFailedStatus = (s: string) => s === 'failed' || s === 'error' || s === 'rejected'

function GalleryView() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  // Full-screen lightbox (complaint: clicking an image opened nothing).
  const [selected, setSelected] = useState<GalleryItem | null>(null)
  // When a branded variant exists, show it by default in the viewer.
  const [showBranded, setShowBranded] = useState(true)
  const openItem = useCallback((item: GalleryItem) => {
    setShowBranded(true)
    setSelected(item)
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await fetchGallery(1)
      setItems(data.items)
    } finally {
      setLoading(false)
    }
  }, [])

  // How many renders are still in flight — drives the "generating" banner and
  // whether we keep polling at all (poll fast while pending, stop when done so
  // we're not re-signing every URL forever).
  const pendingCount = items.filter((i) => isPendingStatus(i.status)).length

  useEffect(() => {
    void load()
  }, [load])

  // Poll ONLY while something is rendering. 4s while pending (snappier than the
  // old fixed 8s), then stop — finished images don't need constant re-fetching.
  useEffect(() => {
    if (pendingCount === 0) return
    const t = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(t)
  }, [pendingCount, load])

  return (
    <div className="px-3 py-3 pb-20 md:pb-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold">Library</h2>
        <button type="button" onClick={() => void load()} className="text-[11px] font-semibold text-[#E07A5F]">
          Refresh
        </button>
      </div>

      {/* "Generation started / in progress" banner — fixes "kono bujhar way nai".
          Shows a live count of renders still cooking so the owner KNOWS work is
          happening after he hits Run. */}
      {pendingCount > 0 && (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] px-3 py-2.5">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
          <span className="text-[12px] font-semibold text-[#E07A5F]">
            {pendingCount}টি ছবি তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে স্যার
          </span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-[4/5] animate-pulse rounded-xl bg-white/[0.05]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">No generations yet — Studio থেকে Run করুন।</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((item) => {
            const isVideo = item.storagePath?.endsWith('.mp4') || item.type === 'video_gen'
            const pending = isPendingStatus(item.status)
            const failed = isFailedStatus(item.status)
            return (
              <motion.button
                key={item.id}
                type="button"
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                onClick={() => item.previewUrl && openItem(item)}
                className="overflow-hidden rounded-xl border border-border-subtle bg-card/80 text-left shadow-sm transition-transform active:scale-[0.98]"
              >
                <div className="relative aspect-[4/5] bg-bg-1">
                  {item.previewUrl ? (
                    isVideo ? (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <video src={item.previewUrl} className="h-full w-full object-cover" playsInline muted />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbUrl ?? item.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    )
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center">
                      {pending ? (
                        <>
                          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
                          <span className="text-[10px] font-medium text-muted">তৈরি হচ্ছে…</span>
                        </>
                      ) : failed ? (
                        <span className="text-[10px] font-medium text-red-400">
                          ব্যর্থ{item.error ? ` · ${item.error.slice(0, 40)}` : ''}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted">{item.status}</span>
                      )}
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
                  {item.brandedUrl && (
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-[#E07A5F]/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                      Branded
                    </span>
                  )}
                  {isVideo && item.previewUrl && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white">▶</span>
                    </span>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-[10px] font-semibold">{item.mode}</p>
                  <p className="text-[9px] text-muted">{new Date(item.createdAt).toLocaleString('en-BD')}</p>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}

      {/* Full-screen viewer */}
      <AnimatePresence>
        {selected?.previewUrl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelected(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
          >
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="বন্ধ করুন"
              className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/20"
            >
              ✕
            </button>
            {selected.storagePath?.endsWith('.mp4') || selected.type === 'video_gen' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={selected.previewUrl} className="max-h-full max-w-full rounded-lg" controls autoPlay playsInline />
            ) : (
              <motion.img
                key={showBranded && selected.brandedUrl ? 'branded' : 'original'}
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                src={(showBranded && selected.brandedUrl) || selected.previewUrl}
                alt=""
                onClick={(e) => e.stopPropagation()}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            )}

            {/* Original ↔ Branded toggle (only when a branded variant exists) */}
            {selected.brandedUrl && !(selected.storagePath?.endsWith('.mp4') || selected.type === 'video_gen') && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-[calc(4rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 overflow-hidden rounded-full bg-white/10 ring-1 ring-white/20"
              >
                <button
                  type="button"
                  onClick={() => setShowBranded(true)}
                  className={cn('px-4 py-1.5 text-[12px] font-semibold', showBranded ? 'bg-[#E07A5F] text-white' : 'text-white/80')}
                >
                  Logo সহ
                </button>
                <button
                  type="button"
                  onClick={() => setShowBranded(false)}
                  className={cn('px-4 py-1.5 text-[12px] font-semibold', !showBranded ? 'bg-[#E07A5F] text-white' : 'text-white/80')}
                >
                  আসল
                </button>
              </div>
            )}

            <a
              href={(showBranded && selected.brandedUrl) || selected.previewUrl}
              download
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25 backdrop-blur-md"
            >
              ডাউনলোড
            </a>
          </motion.div>
        )}
      </AnimatePresence>
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
        className="mb-3 overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/80"
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
          <div key={m.id} className="flex items-center justify-between rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
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

function BrandingView() {
  const [config, setConfig] = useState<BrandingConfig | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const logoRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void fetchBranding()
      .then((c) => {
        setConfig(c)
        setLogoUrl(c.logoUrl ?? null)
      })
      .catch(() => setConfig(null))
  }, [])

  const set = <K extends keyof BrandingConfig>(k: K, v: BrandingConfig[K]) =>
    setConfig((c) => (c ? { ...c, [k]: v } : c))

  const onSave = async () => {
    if (!config) return
    setSaving(true)
    try {
      const saved = await saveBranding(config, logoFile)
      setConfig(saved)
      setLogoUrl(saved.logoUrl ?? null)
      setLogoFile(null)
      if (logoPreview) URL.revokeObjectURL(logoPreview)
      setLogoPreview(null)
      toast.success('Branding সেভ হয়েছে স্যার — পরের ছবিগুলোতে বসবে।')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!config) {
    return <div className="mx-auto max-w-lg px-3 py-6 text-sm text-muted">Loading…</div>
  }

  return (
    <div className="mx-auto max-w-lg px-3 py-4 pb-10">
      <h2 className="mb-1 text-sm font-bold">Branding (Logo + Code + Hook)</h2>
      <p className="mb-4 text-[11px] leading-snug text-muted">
        লোগো আপলোড করুন — যেকোনো সাইজ চলবে, সিস্টেম নিজে রিসাইজ করে নেবে। প্রস্তাবিত: PNG (transparent background), লম্বা দিকে ৫০০–৬০০px। প্রতিটা ছবির একটা আলাদা &quot;branded&quot; কপি বানানো হবে — আসল ছবি অক্ষত থাকবে।
      </p>

      {/* Enable toggle */}
      <label className="mb-3 flex items-center justify-between rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
        <span className="text-sm font-semibold">Branding চালু</span>
        <input type="checkbox" checked={config.enabled} onChange={(e) => set('enabled', e.target.checked)} className="h-5 w-5 accent-[#E07A5F]" />
      </label>

      {/* Logo upload */}
      <div
        className="mb-3 overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/80"
        onClick={() => logoRef.current?.click()}
      >
        <input
          ref={logoRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setLogoFile(f)
            if (logoPreview) URL.revokeObjectURL(logoPreview)
            setLogoPreview(URL.createObjectURL(f))
          }}
        />
        {logoPreview || logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoPreview ?? logoUrl ?? ''} alt="Logo" className="mx-auto max-h-36 object-contain p-3" style={{ background: 'repeating-conic-gradient(#0000000d 0% 25%, transparent 0% 50%) 50% / 16px 16px' }} />
        ) : (
          <p className="py-10 text-center text-sm text-muted">লোগো আপলোড করুন</p>
        )}
      </div>

      {/* Placement + size */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          লোগোর অবস্থান
          <select
            value={config.placement}
            onChange={(e) => set('placement', e.target.value as BrandingConfig['placement'])}
            className="rounded-xl border border-border px-3 py-2.5 text-sm text-cream"
          >
            <option value="bottom-right">নিচে ডানে</option>
            <option value="bottom-left">নিচে বামে</option>
            <option value="bottom-center">নিচে মাঝে</option>
            <option value="top-right">উপরে ডানে</option>
            <option value="top-left">উপরে বামে</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          লোগোর সাইজ ({config.logoWidthPct}% প্রস্থ)
          <input
            type="range"
            min={5}
            max={40}
            value={config.logoWidthPct}
            onChange={(e) => set('logoWidthPct', Number(e.target.value))}
            className="mt-3 accent-[#E07A5F]"
          />
        </label>
      </div>

      {/* Code */}
      <label className="mb-2 flex items-center justify-between rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
        <span className="text-sm font-semibold">Product code দেখাও</span>
        <input type="checkbox" checked={config.showCode} onChange={(e) => set('showCode', e.target.checked)} className="h-5 w-5 accent-[#E07A5F]" />
      </label>
      {config.showCode && (
        <input
          value={config.codePrefix}
          onChange={(e) => set('codePrefix', e.target.value)}
          placeholder="Code prefix (e.g. Code: )"
          className="mb-3 w-full rounded-xl border border-border px-3 py-2.5 text-sm text-cream"
        />
      )}

      {/* Hook */}
      <label className="mb-2 flex items-center justify-between rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
        <span className="text-sm font-semibold">Hook লেখা দেখাও</span>
        <input type="checkbox" checked={config.showHook} onChange={(e) => set('showHook', e.target.checked)} className="h-5 w-5 accent-[#E07A5F]" />
      </label>
      {config.showHook && (
        <input
          value={config.defaultHook}
          onChange={(e) => set('defaultHook', e.target.value)}
          placeholder="ডিফল্ট hook (যেমন: ঈদ স্পেশাল অফার)"
          maxLength={80}
          className="mb-3 w-full rounded-xl border border-border px-3 py-2.5 text-sm text-cream"
        />
      )}

      {/* Text color */}
      <label className="mb-5 flex items-center justify-between rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
        <span className="text-sm font-semibold">লেখার রং</span>
        <input type="color" value={config.textColor} onChange={(e) => set('textColor', e.target.value)} className="h-8 w-12 rounded" />
      </label>

      <button
        type="button"
        disabled={saving}
        onClick={() => void onSave()}
        className="w-full rounded-xl bg-[#E07A5F] py-3 text-sm font-bold text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Branding সেভ করুন'}
      </button>
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
function BrandingSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L3 13V3h10z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { Toaster, toast } from 'react-hot-toast'
import { cn } from '@/lib/utils'
import { saveImageToDevice } from '@/lib/capacitor-native'
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
  VIDEO_RECIPES,
  VIDEO_ASPECTS,
  MUSIC_VIBES,
  AUDIO_MODES,
  VOICEOVER_MAX_CHARS,
  reelCostBdt,
  type VideoAudioMode,
} from '@/lib/creative-studio/video-recipes'
import LifestyleEditor from '@/agent/components/creative-studio/LifestyleEditor'
import {
  DEFAULT_OFFER,
  LIFESTYLE_EST,
  LIFESTYLE_THEME_TOKENS,
  type LifestyleLayoutOverrides,
} from '@/lib/content-engine/lifestyle-layout'
import {
  fetchStudioConfig,
  fetchGallery,
  fetchModels,
  runAutoStudioJob,
  runStudioJob,
  saveModel,
  uploadStudioFile,
  fetchBrandStatus,
  saveBrandLogo,
  finishImage,
  fetchDriveStatus,
  disconnectDrive,
  connectDriveUrl,
  fetchStudioVideos,
  uploadStudioVideo,
  deleteStudioVideo,
  runVideoRecipe,
  fetchVideoJob,
  fetchMusicTracks,
  uploadMusicTrack,
  deleteMusicTrack,
  setReelCover,
  finishVideo,
  sendItemFeedback,
  retryStudioJob,
  fetchStudioSettings,
  saveStudioSettings,
  deleteGarmentCache,
  generateBrandModel,
  type StudioSettings,
  fetchAudioLabStatus,
  queueAudioJob,
  uploadAudioFile,
  type AudioLabStatus,
  type StudioMusicTrack,
  type VideoFinishTemplates,
  type GalleryItem,
  type StudioConfig,
  type BrandStatus,
  type FinishMode,
  type DriveStatus,
  type StudioVideoUpload,
  type VideoJobStatus,
} from '@/agent/components/creative-studio/studio-api'

/** Native-safe download — a plain <a download> just opens a browser URL inside the
 * iOS app shell. saveImageToDevice fetches a blob → share sheet / blob anchor. */
async function handleDownload(url: string | undefined | null, filename?: string) {
  if (!url) return
  const result = await saveImageToDevice(url, filename)
  if (result === 'downloaded') toast.success('ডাউনলোড হয়েছে, স্যার')
  else if (result === 'opened') toast('ছবি নতুন ট্যাবে খোলা হলো, স্যার')
}

type MainView = 'studio' | 'gallery' | 'models' | 'finishing' | 'video' | 'audio'
type StudioModel = { id: string; name: string; role: string | null; isDefault: boolean }

// These modes carry no product image, so the Gemini fallback (which requires a
// product) can't serve them — they only render through FASHN. Gate them in the
// UI so the owner never picks a mode that will fail server-side.
const FASHN_ONLY_MODES: StudioModeId[] = ['model_swap', 'face_to_model', 'edit']

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
    <div className="cs-dark flex h-full min-h-0 w-full overflow-hidden text-cream" style={{ background: 'radial-gradient(1200px 800px at 80% -10%, rgba(224,122,95,0.10), transparent 55%), radial-gradient(900px 700px at -10% 110%, rgba(139,124,246,0.08), transparent 50%), #100d16' }}>
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
        <NavIcon label="Finishing" active={view === 'finishing'} onClick={() => setView('finishing')}>
          <BrandingSvg />
        </NavIcon>
        <NavIcon label="Video" active={view === 'video'} onClick={() => setView('video')}>
          <VideoSvg />
        </NavIcon>
        <NavIcon label="Audio" active={view === 'audio'} onClick={() => setView('audio')}>
          <AudioSvg />
        </NavIcon>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card/85 px-3 pb-2.5 backdrop-blur-md sm:px-4"
          style={{ paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/agent"
              aria-label="পিছনে — চ্যাট"
              className="alma-frost alma-pod grid h-8 w-8 shrink-0 place-items-center text-cream transition-transform active:scale-95"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <div className="min-w-0">
              <p className="text-sm font-bold text-cream">Creative Studio</p>
              <p className="text-[10px] text-muted">{config?.organization ?? 'Alma Traders'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* A1: catalog images cross-link — one central creative place */}
            <Link href="/agent/catalog-images" className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-muted hover:text-cream">
              📸 ক্যাটালগ
            </Link>
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
            {view === 'finishing' && (
              <motion.div key="finishing" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <FinishingView />
              </motion.div>
            )}
            {view === 'video' && (
              <motion.div key="video" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <VideoStudioView onOpenGallery={() => setView('gallery')} />
              </motion.div>
            )}
            {view === 'audio' && (
              <motion.div key="audio" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <AudioLabView />
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
              ['finishing', 'Finishing', BrandingSvg],
              ['video', 'Video', VideoSvg],
              ['audio', 'Audio', AudioSvg],
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
  // full_family merge: 2nd already-generated image (e.g. ma+meye) composited with the 1st.
  const [secondSourcePreview, setSecondSourcePreview] = useState<string | null>(null)
  const [secondSourcePath, setSecondSourcePath] = useState<string | null>(null)
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

  // full_family merge mode: combine two uploaded images (baba+chele + ma+meye) into one shot.
  const isFamilyMerge =
    familyPreset === 'full_family' && (mode === 'product_to_model' || mode === 'try_on')

  // Any multi-person family preset (baba+chele, ma+meye, full family) must render on
  // Gemini — FASHN tryon-max is single-person only and can't place 2+ people. The
  // backend already forces this; mirror it in the UI so the Run button / provider
  // label is honest instead of saying "FASHN Pro" while Gemini actually runs.
  const isMultiPersonFamily =
    familyPreset !== 'single' && (mode === 'product_to_model' || mode === 'try_on')
  const effectiveProvider: StudioProvider = isMultiPersonFamily ? 'gemini' : provider

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

  const fashnOnly = FASHN_ONLY_MODES.includes(mode)

  useEffect(() => {
    if (mode === 'image_to_video') setProvider('gemini')
    else if (fashnOnly) setProvider('fashn') // these modes have no Gemini path
    else if (config?.fashnConfigured) setProvider('fashn')
    else setProvider('gemini')
  }, [config, mode, fashnOnly])

  // Switching mode invalidates the previously uploaded images (e.g. a Try-On
  // product makes no sense as a Model-Swap source). Clear previews + paths so a
  // stale upload from a different mode can't silently flow into the next Run.
  const clearUploads = useCallback(() => {
    setProductPreview((p) => { if (p) URL.revokeObjectURL(p); return null })
    setModelPreview((p) => { if (p) URL.revokeObjectURL(p); return null })
    setSourcePreview((p) => { if (p) URL.revokeObjectURL(p); return null })
    setSecondSourcePreview((p) => { if (p) URL.revokeObjectURL(p); return null })
    setProductPath(null)
    setModelPath(null)
    setSourcePath(null)
    setSecondSourcePath(null)
  }, [])

  const selectMode = useCallback(
    (next: StudioModeId) => {
      if (next === mode) return
      if (FASHN_ONLY_MODES.includes(next) && !config?.fashnConfigured) {
        toast.error('এই mode-এর জন্য FASHN Pro দরকার — এখন configure করা নেই।')
        return
      }
      clearUploads()
      setMode(next)
    },
    [mode, config, clearUploads],
  )

  const upload = async (file: File, kind: 'product' | 'model' | 'source' | 'source2') => {
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
    } else if (kind === 'source2') {
      if (secondSourcePreview) URL.revokeObjectURL(secondSourcePreview)
      setSecondSourcePreview(url)
      setSecondSourcePath(path)
    } else {
      if (sourcePreview) URL.revokeObjectURL(sourcePreview)
      setSourcePreview(url)
      setSourcePath(path)
    }
  }

  const canRun = useMemo(() => {
    if (mode === 'image_to_video') return Boolean(sourcePath || productPath || modelPath)
    // Family merge needs BOTH uploaded images (1st = baba+chele, 2nd = ma+meye).
    if (isFamilyMerge) return Boolean((sourcePath ?? productPath) && secondSourcePath)
    if (modeDef.needsProduct && !productPath) return false
    if (modeDef.needsModel && !modelPath && !modelId) return false
    if (modeDef.needsSource && !sourcePath) return false
    return true
  }, [mode, modeDef, productPath, modelPath, modelId, sourcePath, isFamilyMerge, secondSourcePath])

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
        secondSourceImagePath: isFamilyMerge ? (secondSourcePath ?? undefined) : undefined,
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
            label={
              isFamilyMerge
                ? 'বাবা + ছেলে ছবি (১ম)'
                : modeDef.needsProduct ? 'Product / mannequin' : 'Product (optional)'
            }
            preview={productPreview}
            onFile={(f) => void upload(f, 'product').catch((e) => toast.error(String(e)))}
            required={modeDef.needsProduct}
          />
          {isFamilyMerge && (
            <UploadTile
              label="মা + মেয়ে ছবি (২য়)"
              preview={secondSourcePreview}
              onFile={(f) => void upload(f, 'source2').catch((e) => toast.error(String(e)))}
              required
            />
          )}
          {!isFamilyMerge && (modeDef.needsModel || mode === 'try_on') && (
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
              {STUDIO_MODES.map((m) => {
                const locked = FASHN_ONLY_MODES.includes(m.id) && !config?.fashnConfigured
                return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => selectMode(m.id)}
                  disabled={locked}
                  title={locked ? 'FASHN Pro দরকার' : undefined}
                  className={cn(
                    'shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all',
                    mode === m.id ? 'bg-gold/20 border border-gold/30 text-cream shadow-sm' : 'bg-white/[0.05] text-muted',
                    locked && 'cursor-not-allowed opacity-40',
                  )}
                >
                  {m.short}{locked ? ' 🔒' : ''}
                </button>
                )
              })}
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
                    <option value="gemini" disabled={fashnOnly}>
                      Draft (Gemini){fashnOnly ? ' — N/A' : ''}
                    </option>
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
                <>Run — {effectiveProvider === 'fashn' ? 'FASHN Pro' : 'Gemini'}</>
              )}
            </motion.button>
            <p className="mt-1.5 text-center text-[10px] text-muted">
              {isMultiPersonFamily && provider === 'fashn'
                ? 'একাধিক মানুষ — FASHN পারে না, Gemini দিয়ে হবে'
                : 'No LLM cost — direct render queue'}
            </p>
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
  // Per-image finishing panel (logo + code + hook) inside the lightbox.
  const [showFinish, setShowFinish] = useState(false)
  const [themes, setThemes] = useState<string[]>(['default'])
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  const openItem = useCallback((item: GalleryItem) => {
    setShowBranded(Boolean(item.brandedUrl))
    setShowFinish(false)
    setSelected(item)
  }, [])

  useEffect(() => {
    void fetchBrandStatus().then((s) => setThemes(s.themes?.length ? s.themes : ['default'])).catch(() => {})
    void fetchDriveStatus().then(setDrive).catch(() => {})
  }, [])

  const onDisconnectDrive = useCallback(async () => {
    try {
      await disconnectDrive()
      setDrive((d) => (d ? { ...d, connected: false, email: null, connectedAt: null } : d))
    } catch { /* ignore — UI stays as-is */ }
  }, [])

  // After finishing: attach the framed copy to the selected item + the grid so the
  // "Logo সহ" toggle appears and survives a reload.
  const applyFinished = useCallback((itemId: string, framedUrl: string) => {
    setSelected((s) => (s && s.id === itemId ? { ...s, brandedUrl: framedUrl } : s))
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, brandedUrl: framedUrl } : it)))
    setShowBranded(true)
    setShowFinish(false)
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

      {/* Google Drive archive status. When connected, the worker auto-uploads
          gallery originals to the owner's own Drive (month folders) and frees
          Supabase space — files stay safe in his 400GB Drive. */}
      {drive?.configured && (
        drive.connected ? (
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2.5">
            <span className="text-sm">☁️</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-emerald-300">
                Google Drive যুক্ত — ছবি/ভিডিও অটো সেভ হচ্ছে
              </p>
              {drive.email && <p className="truncate text-[10px] text-emerald-400/70">{drive.email}</p>}
            </div>
            <button type="button" onClick={() => void onDisconnectDrive()} className="shrink-0 text-[11px] font-semibold text-muted hover:text-white">
              বিচ্ছিন্ন করুন
            </button>
          </div>
        ) : (
          <a href={connectDriveUrl()} className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] px-3 py-2.5">
            <span className="text-sm">☁️</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-[#E07A5F]">Google Drive যুক্ত করুন</p>
              <p className="truncate text-[10px] text-[#E07A5F]/70">ছবি/ভিডিও আপনার Drive-এ অটো সেভ + জায়গা খালি রাখুন</p>
            </div>
            <span className="shrink-0 rounded-lg bg-[#E07A5F] px-2.5 py-1 text-[11px] font-bold text-white">যুক্ত করুন</span>
          </a>
        )
      )}

      {/* "Generation started / in progress" banner — fixes "kono bujhar way nai".
          Shows a live count of renders still cooking so the owner KNOWS work is
          happening after he hits Run. */}
      {pendingCount > 0 && (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] px-3 py-2.5">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
          <span className="text-[12px] font-semibold text-[#E07A5F]">
            {pendingCount}টি ছবি/ভিডিও তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে স্যার
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
            const isAudio = item.type === 'audio_gen'
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
                    isAudio ? (
                      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-2 text-center">
                        <span className="text-3xl">🎵</span>
                        <span className="line-clamp-3 text-[10px] text-muted">{item.summary}</span>
                      </div>
                    ) : isVideo ? (
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
                        <span className="flex flex-col items-center gap-1.5">
                          <span className="text-[10px] font-medium text-red-400">
                            ব্যর্থ{item.error ? ` · ${item.error.slice(0, 40)}` : ''}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              void retryStudioJob(item.id)
                                .then(() => { toast.success('আবার চালানো হচ্ছে, স্যার'); void load() })
                                .catch((err) => toast.error(err instanceof Error ? err.message : 'হয়নি'))
                            }}
                            className="rounded-full bg-[#E07A5F] px-2.5 py-1 text-[10px] font-bold text-white"
                          >
                            🔁 আবার চালাও
                          </span>
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
            {selected.type === 'audio_gen' ? (
              <div onClick={(e) => e.stopPropagation()} className="flex w-[min(92vw,420px)] flex-col items-center gap-3 rounded-2xl bg-black/70 p-5 ring-1 ring-white/15">
                <span className="text-4xl">🎵</span>
                <p className="text-center text-[12px] text-white/85">{selected.summary}</p>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={selected.previewUrl} controls autoPlay className="w-full" />
                <button
                  type="button"
                  onClick={() => handleDownload(selected.previewUrl, `alma-${selected.id}.mp3`)}
                  className="rounded-full bg-white/15 px-5 py-2 text-[12px] font-semibold text-white ring-1 ring-white/25"
                >
                  ডাউনলোড
                </button>
              </div>
            ) : selected.storagePath?.endsWith('.mp4') || selected.type === 'video_gen' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video
                key={showBranded && selected.brandedUrl ? 'branded' : 'original'}
                src={(showBranded && selected.brandedUrl) || selected.previewUrl}
                className="max-h-full max-w-full rounded-lg"
                controls
                autoPlay
                playsInline
              />
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

            {/* Action bar: Finishing (logo + code + hook) + Download */}
            {!(selected.storagePath?.endsWith('.mp4') || selected.type === 'video_gen') && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-2"
              >
                {selected.storagePath && (
                  <button
                    type="button"
                    onClick={() => setShowFinish((v) => !v)}
                    className="rounded-full bg-[#E07A5F] px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25"
                  >
                    {showFinish ? 'বন্ধ করুন' : 'ফিনিশিং (logo + code + hook)'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleDownload((showBranded && selected.brandedUrl) || selected.previewUrl, `alma-${selected.id}.jpg`)}
                  className="rounded-full bg-white/15 px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25 backdrop-blur-md"
                >
                  ডাউনলোড
                </button>
                {/* CS4: ভালো/বাদ → deterministic scene weighting */}
                {selected.status === 'executed' && (
                  <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 ring-1 ring-white/20 backdrop-blur-md">
                    {(['good', 'bad'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          void sendItemFeedback(selected.id, v)
                            .then((r) => toast.success(r.weighted ? (v === 'good' ? 'এই ধরনের সিন বেশি আসবে' : 'এই সিন কম আসবে') : 'নোট করা হলো'))
                            .catch(() => toast.error('হয়নি'))
                        }}
                        className={cn('rounded-full px-2.5 py-1 text-[12px] font-bold', v === 'good' ? 'bg-[#81B29A] text-white' : 'bg-white/15 text-white')}
                      >
                        {v === 'good' ? '👍 ভালো' : '👎 বাদ'}
                      </button>
                    ))}
                  </div>
                )}
                {/* CS4: AI-generated brand model → save into the Models library */}
                {selected.modelCreator && selected.status === 'executed' && selected.storagePath && (
                  <button
                    type="button"
                    onClick={() => {
                      void saveModel({
                        id: `brand-${selected.modelCreator}`,
                        name: `ALMA ${selected.modelCreator}`,
                        imagePath: selected.storagePath!,
                        role: selected.modelCreator!,
                      })
                        .then(() => toast.success('মডেল লাইব্রেরিতে সেভ হয়েছে, স্যার'))
                        .catch((err) => toast.error(err instanceof Error ? err.message : 'সেভ হয়নি'))
                    }}
                    className="rounded-full bg-[#81B29A] px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25"
                  >
                    ✅ মডেল হিসেবে সেভ ({selected.modelCreator})
                  </button>
                )}
                {/* V4: one-tap reel from any finished studio image — the family
                    merge becomes a moving reel; 16/24s = multi-clip Veo chain */}
                {selected.status === 'executed' && selected.storagePath && (
                  <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 ring-1 ring-white/20 backdrop-blur-md">
                    <span className="pl-1 text-[11px] font-semibold text-white/80">রিল:</span>
                    {[6, 16, 24].map((d) => {
                      const cost = d >= 16 ? reelCostBdt(8) * Math.round(d / 8) : reelCostBdt(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            void runStudioJob({ mode: 'image_to_video', sourceImagePath: selected.storagePath ?? undefined, durationSec: d })
                              .then(() => toast.success(`${d}s রিল তৈরি হচ্ছে (~৳${cost}) — Gallery-তে আসবে, স্যার`))
                              .catch((e) => toast.error(e instanceof Error ? e.message : 'শুরু করা যায়নি'))
                          }}
                          className="rounded-full bg-[#E07A5F] px-2.5 py-1 text-[11px] font-bold text-white"
                        >
                          {d}s ~৳{cost}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {selected.type === 'video_gen' || selected.storagePath?.endsWith('.mp4') ? (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
              >
                {/* V2: reel cover picker — FB/IG reels need a cover frame */}
                {(selected.coverOptions?.length ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 rounded-2xl bg-black/60 p-1.5 ring-1 ring-white/15 backdrop-blur-md">
                    <span className="px-1 text-[10px] font-semibold text-white/80">কভার:</span>
                    {selected.coverOptions!.map((c) => (
                      <button
                        key={c.path}
                        type="button"
                        onClick={() => {
                          void setReelCover(selected.id, c.path)
                            .then(() => toast.success('কভার সেট হয়েছে, স্যার'))
                            .catch(() => toast.error('কভার সেট করা যায়নি'))
                        }}
                        className="h-12 w-8 overflow-hidden rounded-md ring-1 ring-white/20"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={c.url} alt="" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
                {selected.brandedUrl && (
                  <div className="flex overflow-hidden rounded-full bg-white/10 ring-1 ring-white/20">
                    <button
                      type="button"
                      onClick={() => setShowBranded(true)}
                      className={cn('px-4 py-1.5 text-[12px] font-semibold', showBranded ? 'bg-[#E07A5F] text-white' : 'text-white/80')}
                    >
                      টেমপ্লেট সহ
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
                <div className="flex items-center gap-2">
                  {selected.status === 'executed' && (
                    <button
                      type="button"
                      onClick={() => setShowFinish((v) => !v)}
                      className="rounded-full bg-[#E07A5F] px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25"
                    >
                      {showFinish ? 'বন্ধ করুন' : 'টেমপ্লেট ফিনিশিং'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDownload((showBranded && selected.brandedUrl) || selected.previewUrl, `alma-${selected.id}.mp4`)}
                    className="rounded-full bg-white/15 px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25 backdrop-blur-md"
                  >
                    ডাউনলোড
                  </button>
                </div>
                {showFinish && (
                  <div className="w-[min(92vw,420px)]">
                    <VideoFinishPanel
                      pendingActionId={selected.id}
                      onDone={() => {
                        setShowFinish(false)
                        void fetchGallery(1).then((d) => {
                          setItems(d.items)
                          const fresh = d.items.find((it) => it.id === selected.id)
                          if (fresh) {
                            setSelected(fresh)
                            setShowBranded(Boolean(fresh.brandedUrl))
                          }
                        })
                        toast.success('টেমপ্লেট বসে গেছে — "টেমপ্লেট সহ" ভার্সন দেখুন, স্যার')
                      }}
                    />
                  </div>
                )}
              </div>
            ) : null}

            {/* Finishing panel — per-image code + hook, applied with the real brand frame */}
            {showFinish && selected.storagePath && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 w-[min(92vw,420px)] -translate-x-1/2"
              >
                <FinishPanel
                  storagePath={selected.storagePath}
                  imageUrl={selected.previewUrl}
                  pendingActionId={selected.id}
                  themes={themes}
                  onDone={(framedUrl) => applyFinished(selected.id, framedUrl)}
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Per-image finishing form. The owner types THIS image's product code + hook (not a
 * global default — images differ), picks a festival theme + layout, and we stamp the
 * real brand frame (logo + brand colours + brand fonts via applyBrandFrame).
 */
function FinishPanel({
  storagePath,
  imageUrl,
  pendingActionId,
  themes,
  onDone,
  dark = true,
}: {
  storagePath: string
  /** photo URL shown as the editor background (original, pre-frame) */
  imageUrl?: string | null
  pendingActionId?: string
  themes: string[]
  onDone: (framedUrl: string, framedPath: string) => void
  dark?: boolean
}) {
  const [hook, setHook] = useState('')
  const [code, setCode] = useState('')
  const [eyebrow, setEyebrow] = useState('')
  const [offer, setOffer] = useState('')
  const [mode, setMode] = useState<FinishMode>('lifestyle')
  const [theme, setTheme] = useState('default')
  const [footer, setFooter] = useState(false)
  const [fit, setFit] = useState<'cover' | 'contain'>('cover')
  const [busy, setBusy] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)

  const themeLabel: Record<string, string> = {
    default: 'সাধারণ',
    eid: 'ঈদ',
    puja: 'পূজা',
    boishakh: 'বৈশাখ',
    winter: 'শীত',
  }

  const isLifestyle = mode === 'lifestyle'

  const run = async (layout?: LifestyleLayoutOverrides | null) => {
    if (!hook.trim()) {
      toast.error(isLifestyle ? 'মূল লেখাটা (headline) দিন স্যার' : 'একটা hook লেখা লাগবে স্যার')
      return
    }
    setBusy(true)
    try {
      const { framedUrl, framedPath } = await finishImage({
        storagePath,
        pendingActionId,
        hook: hook.trim(),
        productCode: code.trim() || undefined,
        eyebrow: isLifestyle ? eyebrow.trim() || undefined : undefined,
        offer: isLifestyle ? offer.trim() || undefined : undefined,
        mode,
        theme,
        footer,
        fit: isLifestyle ? fit : undefined,
        layout: isLifestyle ? layout ?? undefined : undefined,
      })
      toast.success('ফিনিশিং হয়ে গেছে স্যার ✅')
      setEditorOpen(false)
      onDone(framedUrl, framedPath)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'ফিনিশিং ব্যর্থ')
    } finally {
      setBusy(false)
    }
  }

  // Open the drag/resize editor — needs the headline + the photo to sit behind it,
  // and the brand logo (fetched lazily, best-effort).
  const openEditor = async () => {
    if (!hook.trim()) {
      toast.error('মূল লেখাটা (headline) দিন স্যার')
      return
    }
    if (!imageUrl) {
      toast.error('এই ছবিটার preview নেই, সরাসরি Finishing করুন')
      return
    }
    if (logoUrl === null) {
      try {
        const b = await fetchBrandStatus()
        setLogoUrl(b.logoUrl ?? '')
      } catch {
        setLogoUrl('')
      }
    }
    setEditorOpen(true)
  }

  const themeToken = LIFESTYLE_THEME_TOKENS[theme] ?? LIFESTYLE_THEME_TOKENS.default
  // Stable reference so the editor isn't re-seeded (drags wiped) on unrelated re-renders.
  const editorTexts = useMemo(
    () => ({
      eyebrow: eyebrow.trim() || themeToken.eyebrow,
      headline: hook.trim(),
      offer: offer.trim() || DEFAULT_OFFER,
      code: code.trim(),
      est: LIFESTYLE_EST,
    }),
    [eyebrow, hook, offer, code, themeToken.eyebrow],
  )

  const field = dark
    ? 'rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-[13px] text-white placeholder:text-white/40'
    : 'rounded-lg border border-border px-3 py-2 text-[13px] text-cream'
  const wrap = dark
    ? 'rounded-2xl border border-white/15 bg-black/70 p-3 backdrop-blur-md'
    : 'rounded-2xl border border-border-subtle bg-card/80 p-3'
  const labelCls = dark ? 'text-[11px] text-white/70' : 'text-[11px] text-muted'

  return (
    <div className={wrap}>
      <div className="grid gap-2">
        {isLifestyle && (
          <input
            value={eyebrow}
            onChange={(e) => setEyebrow(e.target.value)}
            placeholder="ছোট লাইন (খালি রাখলে: নতুন এসেছে)"
            maxLength={32}
            className={cn('w-full', field)}
          />
        )}
        <input
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          placeholder={isLifestyle ? 'মূল লেখা (যেমন: পার্পেল কালার ফ্যামিলি কম্বো সেট)' : 'Hook (যেমন: ঈদ স্পেশাল অফার)'}
          maxLength={isLifestyle ? 80 : 64}
          className={cn('w-full', field)}
        />
        {isLifestyle && (
          <input
            value={offer}
            onChange={(e) => setOffer(e.target.value)}
            placeholder="অফার লাইন (খালি রাখলে: অফার প্রাইস জানতে ইনবক্স করুন)"
            maxLength={48}
            className={cn('w-full', field)}
          />
        )}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Product code (যেমন: ALM-315) — ঐচ্ছিক"
          maxLength={24}
          className={cn('w-full', field)}
        />
        <div className="grid grid-cols-2 gap-2">
          <label className={cn('flex flex-col gap-1', labelCls)}>
            লেআউট
            <select value={mode} onChange={(e) => setMode(e.target.value as FinishMode)} className={field}>
              <option value="lifestyle">পূর্ণ ছবি পোস্টার</option>
              <option value="model_overlay">ছবির উপর (overlay)</option>
              <option value="product_card">প্রোডাক্ট কার্ড</option>
            </select>
          </label>
          <label className={cn('flex flex-col gap-1', labelCls)}>
            থিম
            <select value={theme} onChange={(e) => setTheme(e.target.value)} className={field}>
              {themes.map((t) => (
                <option key={t} value={t}>{themeLabel[t] ?? t}</option>
              ))}
            </select>
          </label>
        </div>
        {mode === 'model_overlay' && (
          <label className={cn('flex items-center justify-between', labelCls)}>
            <span>নিচে ফুটার (পেজ নাম + অর্ডার লাইন)</span>
            <input type="checkbox" checked={footer} onChange={(e) => setFooter(e.target.checked)} className="h-4 w-4 accent-[#E07A5F]" />
          </label>
        )}
        {isLifestyle && (
          <label className={cn('flex flex-col gap-1', labelCls)}>
            ছবির সাইজ
            <select value={fit} onChange={(e) => setFit(e.target.value as 'cover' | 'contain')} className={field}>
              <option value="cover">পোস্টার ১০৮০×১০৮০ (ক্রপ করে ভরাট)</option>
              <option value="contain">পুরো ছবি রাখুন (ক্রপ ছাড়া)</option>
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="mt-0.5 w-full rounded-lg bg-[#E07A5F] py-2.5 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {busy ? 'হচ্ছে…' : 'Finishing করুন'}
        </button>
        {isLifestyle && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void openEditor()}
            className={cn(
              'w-full rounded-lg border py-2.5 text-[13px] font-semibold disabled:opacity-50',
              dark ? 'border-white/25 text-white/85' : 'border-border text-cream',
            )}
          >
            🎚️ সাজিয়ে নিন (টেনে ছোট-বড়)
          </button>
        )}
      </div>

      {editorOpen && imageUrl && (
        <LifestyleEditor
          imageUrl={imageUrl}
          logoUrl={logoUrl || null}
          accent={themeToken.accent}
          texts={editorTexts}
          fit={fit}
          busy={busy}
          onCancel={() => setEditorOpen(false)}
          onApply={(overrides) => void run(overrides)}
        />
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

      <ModelCreatorCard models={models} onQueued={() => void load()} />
      <StudioSettingsCard />
    </div>
  )
}

/** CS4 — generate the brand's FICTIONAL models once (no real children's photos). */
function ModelCreatorCard({ models, onQueued }: { models: Array<{ role: string | null }>; onQueued: () => void }) {
  const roles = [
    { id: 'father', bn: 'বাবা' },
    { id: 'mother', bn: 'মা' },
    { id: 'son', bn: 'ছেলে' },
    { id: 'daughter', bn: 'মেয়ে' },
  ]
  const have = new Set(models.map((m) => m.role))
  return (
    <div className="mt-4 rounded-xl border border-border-subtle bg-card/80 p-3">
      <p className="text-[12px] font-bold text-cream">🧑‍🎨 AI দিয়ে ব্র্যান্ড মডেল বানাও</p>
      <p className="mb-2 text-[10px] text-muted">
        একবার বানালে একই মুখ প্রতিবার ফিরে আসবে — বাচ্চার আসল ছবি লাগবে না। তৈরি হলে Gallery-তে গিয়ে “মডেল হিসেবে সেভ” চাপুন।
      </p>
      <div className="flex flex-wrap gap-1.5">
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              void generateBrandModel(r.id)
                .then(() => { toast.success(`${r.bn} মডেল তৈরি হচ্ছে — Gallery-তে আসবে`); onQueued() })
                .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[11px] font-semibold',
              have.has(r.id) ? 'bg-white/10 text-muted' : 'bg-[#E07A5F] text-white',
            )}
          >
            {r.bn}{have.has(r.id) ? ' ✓ আছে' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

/** CS4 — QC level + Telegram done-ping + child-garment cache management. */
function StudioSettingsCard() {
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  useEffect(() => {
    void fetchStudioSettings().then(setSettings).catch(() => {})
  }, [])
  if (!settings) return null
  return (
    <div className="mt-3 space-y-2.5 rounded-xl border border-border-subtle bg-card/80 p-3">
      <p className="text-[12px] font-bold text-cream">⚙️ স্টুডিও সেটিংস</p>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">ছবির QC (মান যাচাই)</span>
        <select
          value={settings.qcLevel}
          onChange={(e) => {
            const qcLevel = e.target.value as StudioSettings['qcLevel']
            setSettings({ ...settings, qcLevel })
            void saveStudioSettings({ qcLevel }).then(() => toast.success('সেভ হয়েছে')).catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="off">বন্ধ</option>
          <option value="normal">নরমাল</option>
          <option value="strict">কড়া</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">কাজ শেষ হলে Telegram-এ জানাও</span>
        <input
          type="checkbox"
          checked={settings.notifyOnDone}
          onChange={(e) => {
            const notifyOnDone = e.target.checked
            setSettings({ ...settings, notifyOnDone })
            void saveStudioSettings({ notifyOnDone }).then(() => toast.success('সেভ হয়েছে')).catch(() => toast.error('হয়নি'))
          }}
          className="h-4 w-4 accent-[#E07A5F]"
        />
      </label>
      {settings.childGarments.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted">বাচ্চার গার্মেন্ট ক্যাশ (খারাপ হলে মুছুন — পরের রানে নতুন হবে)</p>
          <div className="flex flex-wrap gap-1.5">
            {settings.childGarments.map((g) => (
              <div key={g.key} className="relative">
                {g.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.url} alt="" className="h-14 w-11 rounded-md object-cover ring-1 ring-white/15" />
                ) : (
                  <div className="grid h-14 w-11 place-items-center rounded-md bg-white/10 text-[9px] text-muted">{g.role}</div>
                )}
                <button
                  type="button"
                  aria-label="মুছুন"
                  onClick={() => {
                    void deleteGarmentCache(g.key)
                      .then(() => setSettings({ ...settings, childGarments: settings.childGarments.filter((x) => x.key !== g.key) }))
                      .catch(() => toast.error('হয়নি'))
                  }}
                  className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-red-500 text-[9px] text-white"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Finishing view: manage the brand LOGO (the only global brand setting the owner
 * touches — colours + fonts come from the brand identity) and finish an UPLOADED
 * image with its own code + hook. Generated images are finished from the Gallery
 * lightbox. Both use the same per-image FinishPanel → applyBrandFrame.
 */
function FinishingView() {
  const [status, setStatus] = useState<BrandStatus | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [savingLogo, setSavingLogo] = useState(false)
  const logoRef = useRef<HTMLInputElement>(null)

  // Upload-and-finish (an image that isn't in the gallery).
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadPath, setUploadPath] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const imgRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void fetchBrandStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  // Auto-save the moment a logo is picked — no separate "save" tap to forget (that
  // two-step flow was why a picked logo could silently never persist). The file is
  // passed in directly (not read from state) to avoid a stale-state race.
  const saveLogoFile = async (file: File) => {
    setSavingLogo(true)
    try {
      const s = await saveBrandLogo(file)
      setStatus(s)
      toast.success('লোগো সেভ হয়েছে স্যার ✅ — পরের ফিনিশিং-এ এটাই বসবে।')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'লোগো সেভ ব্যর্থ')
    } finally {
      setSavingLogo(false)
    }
  }

  const onPickImage = (f: File) => {
    setResultUrl(null)
    if (uploadPreview) URL.revokeObjectURL(uploadPreview)
    setUploadPreview(URL.createObjectURL(f))
    setUploadPath(null)
    setUploading(true)
    void uploadStudioFile(f, 'finishing')
      .then(setUploadPath)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ'))
      .finally(() => setUploading(false))
  }

  const themes = status?.themes?.length ? status.themes : ['default']

  return (
    <div className="mx-auto max-w-lg px-3 py-4 pb-12">
      <h2 className="mb-1 text-sm font-bold">Finishing (logo + code + hook)</h2>
      <p className="mb-4 text-[11px] leading-snug text-muted">
        লোগো, রং আর ফন্ট আপনার ব্র্যান্ড সেটিং থেকেই আসে। কোড আর hook প্রতিটা ছবির জন্য আলাদা করে এখানে লিখবেন — Gallery-র যেকোনো ছবিতে &quot;ফিনিশিং&quot; চাপলেও একই অপশন আসবে। আসল ছবি অক্ষত থাকে, আলাদা একটা ব্র্যান্ডেড কপি তৈরি হয়।
      </p>

      {status && !status.hasLogo && (
        <div className="mb-4 rounded-xl border border-[#C89B3C]/40 bg-[#C89B3C]/10 px-3 py-2.5 text-[11px] leading-snug text-[#C89B3C]">
          ⚠️ এখনো কোনো লোগো আপলোড করা হয়নি, স্যার। লোগো ছাড়া ফিনিশিং করলে ছবিতে শুধু লেখা আর রং বসবে, লোগো বসবে না। নিচে একবার আপনার লোগো আপলোড করে নিন — এরপর প্রতিটা ফিনিশিং-এ এটাই বসবে।
        </div>
      )}

      {/* ── Brand logo (changeable) ──────────────────────────────────────────── */}
      <h3 className="mb-1.5 text-[12px] font-bold text-cream">ব্র্যান্ড লোগো</h3>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        যেকোনো সাইজ চলবে — সিস্টেম নিজে রিসাইজ করে নেবে। সবচেয়ে ভালো: PNG (transparent background)। লোগো বদলাতে চাইলে নতুনটা আপলোড করে সেভ করুন।
      </p>
      <div
        className="mb-2 overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/80"
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
            if (logoPreview) URL.revokeObjectURL(logoPreview)
            setLogoPreview(URL.createObjectURL(f))
            void saveLogoFile(f) // auto-save immediately — no separate button to miss
          }}
        />
        {logoPreview || status?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoPreview ?? status?.logoUrl ?? ''}
            alt="Logo"
            className="mx-auto max-h-32 object-contain p-3"
            style={{ background: 'repeating-conic-gradient(#0000000d 0% 25%, transparent 0% 50%) 50% / 16px 16px' }}
          />
        ) : (
          <p className="py-8 text-center text-sm text-muted">লোগো আপলোড করুন</p>
        )}
      </div>
      {savingLogo ? (
        <p className="mb-6 text-center text-[12px] font-semibold text-[#E07A5F]">লোগো সেভ হচ্ছে…</p>
      ) : status?.hasLogo ? (
        <p className="mb-6 text-center text-[11px] text-muted">✅ লোগো সেভ আছে — বদলাতে চাইলে নতুন একটা সিলেক্ট করুন।</p>
      ) : (
        <div className="mb-6" />
      )}

      {/* ── Finish an uploaded image ─────────────────────────────────────────── */}
      <h3 className="mb-1.5 text-[12px] font-bold text-cream">ছবি আপলোড করে ফিনিশিং</h3>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        নিজের একটা ছবি আপলোড করুন, তারপর সেই ছবির কোড আর hook লিখে ফিনিশিং করুন।
      </p>
      <div
        className="mb-3 overflow-hidden rounded-2xl border-2 border-dashed border-border bg-card/80"
        onClick={() => imgRef.current?.click()}
      >
        <input
          ref={imgRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPickImage(f)
          }}
        />
        {uploadPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resultUrl ?? uploadPreview} alt="" className="mx-auto max-h-72 object-contain p-2" />
        ) : (
          <p className="py-10 text-center text-sm text-muted">ছবি আপলোড করুন</p>
        )}
      </div>

      {uploadPath && !resultUrl && (
        <FinishPanel
          storagePath={uploadPath}
          imageUrl={uploadPreview}
          themes={themes}
          dark={false}
          onDone={(framedUrl) => setResultUrl(framedUrl)}
        />
      )}
      {uploading && <p className="text-center text-[11px] text-muted">আপলোড হচ্ছে…</p>}

      {resultUrl && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => handleDownload(resultUrl, `alma-finished-${Date.now()}.jpg`)}
            className="flex-1 rounded-xl bg-[#E07A5F] py-2.5 text-center text-sm font-bold text-white"
          >
            ডাউনলোড
          </button>
          <button
            type="button"
            onClick={() => { setResultUrl(null) }}
            className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-muted"
          >
            আবার ফিনিশিং
          </button>
        </div>
      )}
    </div>
  )
}

function VideoSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 9l5 3-5 3z" />
    </svg>
  )
}

/**
 * Phase V1 — Video Studio. The owner uploads his 1–2 min phone shoot, taps a
 * Recipe (hard presets — zero prompts, zero LLM), and the VPS worker cuts it
 * into ready reels that land in the Gallery. Replaces the old OpenCut iframe.
 */
function VideoStudioView({ onOpenGallery }: { onOpenGallery: () => void }) {
  const [uploads, setUploads] = useState<StudioVideoUpload[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [selected, setSelected] = useState<StudioVideoUpload | null>(null)
  const [recipeId, setRecipeId] = useState<string>(VIDEO_RECIPES[0].id)
  const [targets, setTargets] = useState<number[]>([VIDEO_RECIPES[0].defaultTarget])
  const [aspect, setAspect] = useState<string>('9:16')
  const [running, setRunning] = useState(false)
  const [jobs, setJobs] = useState<Array<{ id: string; label: string; status: VideoJobStatus | null }>>([])
  const fileRef = useRef<HTMLInputElement>(null)

  // ── V2 options (defaults = V1 behaviour) ─────────────────────────────────
  const [captions, setCaptions] = useState(false)
  const [audioMode, setAudioMode] = useState<VideoAudioMode>('original')
  const [musicTrackId, setMusicTrackId] = useState<string>('auto')
  const [voiceoverText, setVoiceoverText] = useState('')
  const [stings, setStings] = useState(false)
  const [aiAssist, setAiAssist] = useState(false)
  const [tracks, setTracks] = useState<StudioMusicTrack[]>([])
  const [showMusicLib, setShowMusicLib] = useState(false)

  const recipe = VIDEO_RECIPES.find((r) => r.id === recipeId) ?? VIDEO_RECIPES[0]

  useEffect(() => {
    void fetchMusicTracks().then(setTracks).catch(() => {})
  }, [])

  const loadUploads = useCallback(async () => {
    try {
      const list = await fetchStudioVideos()
      setUploads(list)
    } catch { /* list stays as-is */ } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => { void loadUploads() }, [loadUploads])

  // Poll running jobs every 4s for ধাপ N/M progress (same rhythm as the gallery).
  const activeJobIds = jobs.filter((j) => !j.status || j.status.status === 'approved' || j.status.status === 'pending').map((j) => j.id).join(',')
  useEffect(() => {
    if (!activeJobIds) return
    const tick = async () => {
      const ids = activeJobIds.split(',')
      const results = await Promise.all(ids.map((id) => fetchVideoJob(id).catch(() => null)))
      setJobs((prev) =>
        prev.map((j) => {
          const idx = ids.indexOf(j.id)
          return idx >= 0 && results[idx] ? { ...j, status: results[idx] } : j
        }),
      )
    }
    void tick()
    const t = window.setInterval(() => void tick(), 4000)
    return () => window.clearInterval(t)
  }, [activeJobIds])

  const handleFile = useCallback(async (file: File | null) => {
    if (!file) return
    setUploadPct(0)
    try {
      const up = await uploadStudioVideo(file, setUploadPct)
      setUploads((prev) => [up, ...prev])
      setSelected(up)
      toast.success('ভিডিও আপলোড হয়েছে, স্যার')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ হয়েছে')
    } finally {
      setUploadPct(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [])

  const handleDelete = useCallback(async (up: StudioVideoUpload) => {
    try {
      await deleteStudioVideo(up.id)
      setUploads((prev) => prev.filter((u) => u.id !== up.id))
      setSelected((s) => (s?.id === up.id ? null : s))
      toast.success('ভিডিও মুছে ফেলা হয়েছে')
    } catch {
      toast.error('মুছতে সমস্যা হলো')
    }
  }, [])

  const handleRun = useCallback(async () => {
    if (!selected || targets.length === 0) return
    setRunning(true)
    try {
      const res = await runVideoRecipe({
        videoPath: selected.path,
        videoName: selected.name,
        recipeId: recipe.id,
        targets,
        aspect,
        options: {
          captions,
          audioMode,
          musicTrackId,
          voiceoverText: voiceoverText.trim() || undefined,
          stings,
          aiAssist,
        },
      })
      setJobs((prev) => [
        ...res.jobs.map((j) => ({ id: j.pendingActionId, label: j.label, status: null })),
        ...prev,
      ])
      toast.success(res.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'রিল বানানো শুরু করা যায়নি')
    } finally {
      setRunning(false)
    }
  }, [selected, recipe, targets, aspect, captions, audioMode, musicTrackId, voiceoverText, stings, aiAssist])

  const fmtSize = (b: number) => (b > 1024 * 1024 ? `${Math.round(b / (1024 * 1024))} MB` : `${Math.round(b / 1024)} KB`)

  return (
    <div className="h-full overflow-y-auto px-3 py-3 pb-20 md:pb-4">
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <h2 className="text-sm font-bold">ভিডিও স্টুডিও</h2>
          <p className="text-[11px] text-muted">নিজের শুট করা ভিডিও দিন — রেসিপি বেছে নিলেই রেডি রিল Gallery-তে চলে আসবে।</p>
        </div>

        {/* Upload */}
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
          className="hidden"
          onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
        />
        {uploadPct !== null ? (
          <div className="rounded-xl border border-border-subtle bg-card/80 p-3">
            <p className="mb-2 text-[11px] font-semibold text-cream">আপলোড হচ্ছে… {uploadPct}%</p>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[#E07A5F] transition-all" style={{ width: `${uploadPct}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] text-muted">বড় ভিডিওতে কয়েক মিনিট লাগতে পারে — পেজ বন্ধ করবেন না।</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[#E07A5F]/40 bg-[#E07A5F]/[0.06] px-4 py-4 text-[12px] font-semibold text-[#E07A5F]"
          >
            <VideoSvg className="h-4 w-4" /> ভিডিও আপলোড করুন (১–২ মিনিটের শুট, mp4/mov)
          </button>
        )}

        {/* Uploaded shoots */}
        {loadingList ? (
          <div className="h-16 animate-pulse rounded-xl bg-white/[0.05]" />
        ) : uploads.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted">আপলোড করা শুট</p>
            {uploads.map((up) => (
              <div
                key={up.id}
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2.5',
                  selected?.id === up.id
                    ? 'border-[#E07A5F]/60 bg-[#E07A5F]/[0.08]'
                    : 'border-border-subtle bg-card/80',
                )}
              >
                <button type="button" onClick={() => setSelected(up)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', selected?.id === up.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted')}>
                    <VideoSvg className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-semibold text-cream">{up.name}</span>
                    <span className="block text-[10px] text-muted">{fmtSize(up.sizeBytes)} · {new Date(up.uploadedAt).toLocaleDateString('en-BD')}</span>
                  </span>
                </button>
                <button type="button" onClick={() => void handleDelete(up)} aria-label="মুছুন" className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-muted hover:text-red-400">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Recipe picker — hard presets, no prompts */}
        {selected && (
          <div className="space-y-3 rounded-xl border border-border-subtle bg-card/80 p-3">
            <p className="text-[11px] font-semibold text-muted">রেসিপি বাছুন — বাকিটা সিস্টেম করবে</p>
            <div className="grid gap-1.5">
              {VIDEO_RECIPES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setRecipeId(r.id)
                    setTargets((prev) => {
                      const kept = prev.filter((t) => r.targets.includes(t))
                      return kept.length > 0 ? kept : [r.defaultTarget]
                    })
                  }}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left',
                    recipeId === r.id ? 'border-[#E07A5F]/60 bg-[#E07A5F]/[0.08]' : 'border-border-subtle bg-bg-1/40',
                  )}
                >
                  <p className={cn('text-[12px] font-bold', recipeId === r.id ? 'text-[#E07A5F]' : 'text-cream')}>{r.labelBn}</p>
                  <p className="text-[10px] text-muted">{r.descriptionBn}</p>
                </button>
              ))}
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-muted">রিলের দৈর্ঘ্য</p>
              <div className="flex gap-1.5">
                {recipe.targets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() =>
                      setTargets((prev) =>
                        prev.includes(t) ? (prev.length > 1 ? prev.filter((x) => x !== t) : prev) : [...prev, t].sort((a, b) => a - b),
                      )
                    }
                    className={cn(
                      'rounded-lg px-3.5 py-1.5 text-[12px] font-semibold',
                      targets.includes(t) ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted',
                    )}
                  >
                    {t}s
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-muted">সাইজ</p>
              <div className="flex gap-1.5">
                {VIDEO_ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAspect(a.id)}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-[11px] font-semibold',
                      aspect === a.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted',
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── V2: caption + audio layer (hard toggles, no prompts) ── */}
            <div className="space-y-2.5 rounded-xl border border-border-subtle bg-bg-1/40 p-2.5">
              <label className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-cream">বাংলা ক্যাপশন</span>
                <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} className="h-4 w-4 accent-[#E07A5F]" />
              </label>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted">সাউন্ড</p>
                <div className="flex gap-1.5">
                  {AUDIO_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setAudioMode(m.id)}
                      className={cn(
                        'rounded-lg px-2.5 py-1.5 text-[11px] font-semibold',
                        audioMode === m.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted',
                      )}
                    >
                      {m.labelBn}
                    </button>
                  ))}
                </div>
              </div>

              {audioMode !== 'original' && (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-muted">মিউজিক ট্র্যাক (আপনার অনুমোদিত লাইব্রেরি)</p>
                  {tracks.length === 0 ? (
                    <p className="text-[11px] text-amber-400">লাইব্রেরি খালি — নিচের “মিউজিক লাইব্রেরি” থেকে ট্র্যাক আপলোড করুন।</p>
                  ) : (
                    <select
                      value={musicTrackId}
                      onChange={(e) => setMusicTrackId(e.target.value)}
                      className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[12px] text-cream"
                    >
                      <option value="auto">অটো (প্রতিবার ভিন্ন ট্র্যাক)</option>
                      {tracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {MUSIC_VIBES.find((v) => v.id === t.vibe)?.labelBn ?? t.vibe}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <div>
                <p className="mb-1 text-[11px] font-semibold text-muted">ভয়েসওভার (ঐচ্ছিক — আপনার লেখা লাইন, আপনার এজেন্টের বাংলা ভয়েসে)</p>
                <textarea
                  value={voiceoverText}
                  onChange={(e) => setVoiceoverText(e.target.value.slice(0, VOICEOVER_MAX_CHARS))}
                  rows={2}
                  placeholder="যেমন: বাবা-ছেলের ম্যাচিং পাঞ্জাবি — অর্ডার করতে ইনবক্স করুন"
                  className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[12px] text-cream placeholder:text-muted/50"
                />
              </div>

              <label className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-cream">ALMA লোগো intro/outro</span>
                <input type="checkbox" checked={stings} onChange={(e) => setStings(e.target.checked)} className="h-4 w-4 accent-[#E07A5F]" />
              </label>

              <label className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-cream">
                  AI হাইলাইট সাজেশন <span className="text-[10px] text-muted">(বিটা)</span>
                </span>
                <input type="checkbox" checked={aiAssist} onChange={(e) => setAiAssist(e.target.checked)} className="h-4 w-4 accent-[#E07A5F]" />
              </label>
            </div>

            <button
              type="button"
              disabled={running || targets.length === 0}
              onClick={() => void handleRun()}
              className="w-full rounded-xl bg-[#E07A5F] py-3 text-[13px] font-bold text-white disabled:opacity-50"
            >
              {running ? 'শুরু হচ্ছে…' : `রিল বানাও (${targets.map((t) => `${t}s`).join(' + ')})`}
            </button>
          </div>
        )}

        {/* Music library — owner-approved beds only (Islamic guardrail) */}
        <div className="rounded-xl border border-border-subtle bg-card/80 p-3">
          <button type="button" onClick={() => setShowMusicLib((v) => !v)} className="flex w-full items-center justify-between">
            <span className="text-[12px] font-bold text-cream">🎵 মিউজিক লাইব্রেরি ({tracks.length})</span>
            <span className="text-[11px] text-muted">{showMusicLib ? '▲' : '▼'}</span>
          </button>
          {showMusicLib && (
            <MusicLibrary tracks={tracks} onChanged={setTracks} />
          )}
        </div>

        {/* Running / finished jobs */}
        {jobs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold text-muted">চলমান কাজ</p>
            {jobs.map((j) => {
              const st = j.status
              const done = st?.status === 'executed'
              const failed = st?.status === 'failed'
              return (
                <div key={j.id} className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5">
                  {done ? (
                    <span className="text-sm">✅</span>
                  ) : failed ? (
                    <span className="text-sm">❌</span>
                  ) : (
                    <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-cream">{j.label}</p>
                    <p className="truncate text-[10px] text-muted">
                      {failed
                        ? st?.error ?? 'ব্যর্থ হয়েছে'
                        : done
                          ? 'রেডি — Gallery-তে দেখুন'
                          : st?.videoProgress
                            ? `ধাপ ${st.videoProgress.step}/${st.videoProgress.total}: ${st.videoProgress.labelBn}`
                            : 'অপেক্ষায়…'}
                    </p>
                  </div>
                  {done && (
                    <button type="button" onClick={onOpenGallery} className="shrink-0 text-[11px] font-semibold text-[#E07A5F]">
                      Gallery →
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * V3 — motion-template finishing for a reel: the video twin of the image
 * FinishPanel. Owner toggles templates + types the values; the worker renders
 * with Remotion and the finished version lands on this same gallery item.
 */
function VideoFinishPanel({ pendingActionId, onDone }: { pendingActionId: string; onDone: () => void }) {
  const [price, setPrice] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [cta, setCta] = useState('')
  const [days, setDays] = useState('')
  const [watermark, setWatermark] = useState(true)
  const [endCard, setEndCard] = useState(true)
  const [state, setState] = useState<'idle' | 'queued' | 'working'>('idle')
  const [progress, setProgress] = useState('')

  const submit = useCallback(async () => {
    const templates: VideoFinishTemplates = {}
    if (price.trim()) templates.pricePop = { price: price.trim() }
    if (code.trim()) templates.lowerThird = { code: code.trim(), name: name.trim() || undefined }
    if (watermark) templates.logoWatermark = true
    if (endCard) templates.endCard = { cta: cta.trim() || undefined, code: code.trim() || undefined, price: price.trim() || undefined }
    if (Number(days) > 0) templates.countdown = { days: Number(days) }

    setState('queued')
    try {
      const res = await finishVideo(pendingActionId, templates)
      setState('working')
      const poll = window.setInterval(() => {
        void fetchVideoJob(res.pendingActionId)
          .then((job) => {
            if (job.videoProgress) setProgress(`ধাপ ${job.videoProgress.step}/${job.videoProgress.total}: ${job.videoProgress.labelBn}`)
            if (job.status === 'executed') {
              window.clearInterval(poll)
              onDone()
            } else if (job.status === 'failed') {
              window.clearInterval(poll)
              setState('idle')
              toast.error(job.error ?? 'টেমপ্লেট বসানো ব্যর্থ হয়েছে')
            }
          })
          .catch(() => {})
      }, 4000)
    } catch (err) {
      setState('idle')
      toast.error(err instanceof Error ? err.message : 'শুরু করা যায়নি')
    }
  }, [pendingActionId, price, code, name, cta, days, watermark, endCard, onDone])

  const inputCls = 'w-full rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-[13px] text-white placeholder:text-white/40'
  return (
    <div className="space-y-2 rounded-2xl bg-black/70 p-3 ring-1 ring-white/15 backdrop-blur-md">
      {state === 'working' ? (
        <div className="flex items-center gap-2.5 py-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
          <span className="text-[12px] text-white/85">{progress || 'টেমপ্লেট রেন্ডার হচ্ছে… (১–৩ মিনিট)'}</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="দাম (৳)" className={inputCls} />
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="প্রোডাক্ট কোড" className={inputCls} />
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="প্রোডাক্টের নাম (ঐচ্ছিক)" className={inputCls} />
          <div className="grid grid-cols-2 gap-2">
            <input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="CTA (ডিফল্ট: অর্ডার করতে ইনবক্স করুন)" className={inputCls} />
            <input value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} placeholder="অফার শেষ হতে দিন" className={inputCls} />
          </div>
          <div className="flex items-center gap-4 py-0.5">
            <label className="flex items-center gap-1.5 text-[12px] text-white/85">
              <input type="checkbox" checked={watermark} onChange={(e) => setWatermark(e.target.checked)} className="h-3.5 w-3.5 accent-[#E07A5F]" />
              লোগো ওয়াটারমার্ক
            </label>
            <label className="flex items-center gap-1.5 text-[12px] text-white/85">
              <input type="checkbox" checked={endCard} onChange={(e) => setEndCard(e.target.checked)} className="h-3.5 w-3.5 accent-[#E07A5F]" />
              এন্ড কার্ড (CTA)
            </label>
          </div>
          <button
            type="button"
            disabled={state !== 'idle'}
            onClick={() => void submit()}
            className="w-full rounded-xl bg-[#E07A5F] py-2.5 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {state === 'queued' ? 'শুরু হচ্ছে…' : 'টেমপ্লেট বসাও'}
          </button>
        </>
      )}
    </div>
  )
}

/** Owner-approved music beds: upload (signed direct), tag by vibe, delete. */
function MusicLibrary({
  tracks,
  onChanged,
}: {
  tracks: StudioMusicTrack[]
  onChanged: (tracks: StudioMusicTrack[]) => void
}) {
  const [vibe, setVibe] = useState<string>(MUSIC_VIBES[0].id)
  const [pct, setPct] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (file: File | null) => {
    if (!file) return
    setPct(0)
    try {
      const track = await uploadMusicTrack(file, vibe, setPct)
      onChanged([track, ...tracks])
      toast.success('ট্র্যাক যোগ হয়েছে, স্যার')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ')
    } finally {
      setPct(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [vibe, tracks, onChanged])

  return (
    <div className="mt-2.5 space-y-2">
      <p className="text-[10px] text-muted">শুধু আপনার অনুমোদিত ট্র্যাকই রিলে বসে — সিস্টেম নিজে কোথাও থেকে মিউজিক আনে না।</p>
      <div className="flex items-center gap-1.5">
        {MUSIC_VIBES.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setVibe(v.id)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-[11px] font-semibold',
              vibe === v.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted',
            )}
          >
            {v.labelBn}
          </button>
        ))}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/mp4,audio/wav,audio/aac,.mp3,.m4a,.wav,.aac"
        className="hidden"
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
      />
      {pct !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-[#E07A5F] transition-all" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="w-full rounded-lg border border-dashed border-[#E07A5F]/40 bg-[#E07A5F]/[0.06] py-2 text-[11px] font-semibold text-[#E07A5F]"
        >
          + ট্র্যাক আপলোড ({MUSIC_VIBES.find((v) => v.id === vibe)?.labelBn} হিসেবে)
        </button>
      )}
      {tracks.map((t) => (
        <div key={t.id} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-1/40 px-2.5 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-cream">{t.name}</span>
          <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-muted">
            {MUSIC_VIBES.find((v) => v.id === t.vibe)?.labelBn ?? t.vibe}
          </span>
          <button
            type="button"
            aria-label="মুছুন"
            onClick={() => {
              void deleteMusicTrack(t.id)
                .then(() => onChanged(tracks.filter((x) => x.id !== t.id)))
                .catch(() => toast.error('মুছতে সমস্যা হলো'))
            }}
            className="shrink-0 text-[11px] text-muted hover:text-red-400"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function AudioSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  )
}

/**
 * E1 — Audio Lab (ElevenLabs). Hard presets + owner-typed lines only; the
 * cloned voice is owner-only by design. Outputs land in the Gallery.
 */
function AudioLabView() {
  const [status, setStatus] = useState<AudioLabStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [musicStyle, setMusicStyle] = useState('celebration')
  const [musicLine, setMusicLine] = useState('')
  const [musicSec, setMusicSec] = useState(30)
  const [occasion, setOccasion] = useState('birthday')
  const [wishName, setWishName] = useState('')
  const [voiceText, setVoiceText] = useState('')
  const [sfxText, setSfxText] = useState('')
  const [pct, setPct] = useState<number | null>(null)
  const cloneRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void fetchAudioLabStatus().then(setStatus).catch(() => {}) }, [])

  const run = useCallback((label: string, body: Record<string, unknown>) => {
    setBusy(label)
    void queueAudioJob(body)
      .then((r) => toast.success(`${label} তৈরি হচ্ছে (~৳${r.costBdt}) — Gallery-তে আসবে, স্যার`))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
      .finally(() => setBusy(null))
  }, [])

  const card = 'space-y-2 rounded-xl border border-border-subtle bg-card/80 p-3'
  const input = 'w-full rounded-lg border border-border-subtle bg-bg-1 px-2.5 py-2 text-[12px] text-cream placeholder:text-muted/50'
  const btn = 'rounded-xl bg-[#E07A5F] px-4 py-2 text-[12px] font-bold text-white disabled:opacity-50'

  return (
    <div className="px-3 py-3 pb-20 md:pb-4">
      <div className="mx-auto max-w-xl space-y-3">
        <div>
          <h2 className="text-sm font-bold">🎙️ অডিও ল্যাব</h2>
          <p className="text-[11px] text-muted">মিউজিক, উইশ গান, আপনার ভয়েস — সব এক জায়গায়। খরচ আগে দেখানো হয়।</p>
        </div>

        {/* voice clone */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">
            🧬 আপনার ভয়েস {status?.voiceCloned ? <span className="text-[#81B29A]">— ক্লোন করা আছে ✓</span> : '— এখনো ক্লোন হয়নি'}
          </p>
          <p className="text-[10px] text-muted">১-৩টা পরিষ্কার ভয়েস রেকর্ডিং দিন (একবারই লাগবে)। এই ভয়েস শুধু আপনার নিজের কাজে ব্যবহার হবে — অটো বা কাস্টমার ফ্লোতে কখনোই না।</p>
          <input ref={cloneRef} type="file" accept="audio/*" multiple className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []).slice(0, 3)
              if (!files.length) return
              setPct(0)
              void Promise.all(files.map((f) => uploadAudioFile(f, setPct)))
                .then((paths) => run('ভয়েস ক্লোন', { kind: 'voice_clone', samplePaths: paths }))
                .catch((err) => toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ'))
                .finally(() => { setPct(null); if (cloneRef.current) cloneRef.current.value = '' })
            }} />
          <button type="button" disabled={busy !== null || pct !== null} onClick={() => cloneRef.current?.click()} className={btn}>
            {pct !== null ? `আপলোড ${pct}%` : status?.voiceCloned ? 'আবার ক্লোন করাও' : 'স্যাম্পল দিয়ে ক্লোন করাও'}
          </button>
        </div>

        {/* text → music */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎵 মিউজিক বানাও</p>
          <div className="flex gap-1.5">
            {(status?.styles ?? []).map((st) => (
              <button key={st.id} type="button" onClick={() => setMusicStyle(st.id)}
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', musicStyle === st.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted')}>
                {st.labelBn}
              </button>
            ))}
          </div>
          <input value={musicLine} onChange={(e) => setMusicLine(e.target.value)} placeholder="মুড/থিম এক লাইনে (ঐচ্ছিক)" className={input} />
          <div className="flex items-center gap-2">
            {[30, 60].map((s2) => (
              <button key={s2} type="button" onClick={() => setMusicSec(s2)}
                className={cn('rounded-lg px-3 py-1.5 text-[11px] font-semibold', musicSec === s2 ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted')}>
                {s2}s
              </button>
            ))}
            <button type="button" disabled={busy !== null} className={btn}
              onClick={() => run('মিউজিক', { kind: 'music', styleId: musicStyle, line: musicLine, seconds: musicSec })}>
              বানাও
            </button>
          </div>
        </div>

        {/* wish song */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎁 উইশ গান (ফিক্সড লিরিক — শুধু নাম বসে)</p>
          <div className="flex gap-1.5">
            {(status?.occasions ?? []).map((o) => (
              <button key={o.id} type="button" onClick={() => setOccasion(o.id)}
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', occasion === o.id ? 'bg-[#E07A5F] text-white' : 'bg-white/10 text-muted')}>
                {o.labelBn}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={wishName} onChange={(e) => setWishName(e.target.value)} placeholder="নাম" className={input} />
            <button type="button" disabled={busy !== null || !wishName.trim()} className={btn}
              onClick={() => run('উইশ গান', { kind: 'wish_song', occasionId: occasion, name: wishName, seconds: 30 })}>
              বানাও
            </button>
          </div>
        </div>

        {/* owner voice */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎙️ আমার ভয়েসে বলাও</p>
          <textarea value={voiceText} onChange={(e) => setVoiceText(e.target.value.slice(0, 600))} rows={2}
            placeholder="যা বলাতে চান লিখুন…" className={input} />
          <button type="button" disabled={busy !== null || !voiceText.trim() || !status?.voiceCloned} className={btn}
            onClick={() => run('ভয়েস লাইন', { kind: 'owner_voice', text: voiceText })}>
            {status?.voiceCloned ? 'বলাও' : 'আগে ভয়েস ক্লোন করুন'}
          </button>
        </div>

        {/* clean voice note */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🎧 ভয়েস নোট → স্টুডিও কোয়ালিটি</p>
          <input ref={noteRef} type="file" accept="audio/*" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setPct(0)
              void uploadAudioFile(f, setPct)
                .then((path) => run('ভয়েস ক্লিনআপ', { kind: 'clean_voice', sourcePath: path }))
                .catch((err) => toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ'))
                .finally(() => { setPct(null); if (noteRef.current) noteRef.current.value = '' })
            }} />
          <button type="button" disabled={busy !== null || pct !== null} onClick={() => noteRef.current?.click()} className={btn}>
            {pct !== null ? `আপলোড ${pct}%` : 'ভয়েস নোট দিন'}
          </button>
        </div>

        {/* sfx */}
        <div className={card}>
          <p className="text-[12px] font-bold text-cream">🔊 সাউন্ড ইফেক্ট (রিলের জন্য)</p>
          <div className="flex gap-2">
            <input value={sfxText} onChange={(e) => setSfxText(e.target.value)} placeholder="যেমন: whoosh, চুড়ির টুংটাং" className={input} />
            <button type="button" disabled={busy !== null || !sfxText.trim()} className={btn}
              onClick={() => run('SFX', { kind: 'sfx', text: sfxText, seconds: 3 })}>
              বানাও
            </button>
          </div>
        </div>
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
function BrandingSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L3 13V3h10z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

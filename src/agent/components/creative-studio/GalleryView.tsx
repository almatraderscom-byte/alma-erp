'use client'

import LifestyleEditor from '@/agent/components/creative-studio/LifestyleEditor'
import MaskEditor, { type MaskEditorResult } from '@/agent/components/creative-studio/MaskEditor'
import {
  connectDriveUrl,
  disconnectDrive,
  fetchBrandStatus,
  fetchDriveStatus,
  fetchGallery,
  finishImage,
  retryStudioJob,
  runStudioJob,
  saveModel,
  sendItemFeedback,
  setReelCover,
  uploadFillMask,
  type DriveStatus,
  type FinishMode,
  type GalleryItem,
} from '@/agent/components/creative-studio/studio-api'
import { DEFAULT_OFFER, LIFESTYLE_EST, LIFESTYLE_THEME_TOKENS, type LifestyleLayoutOverrides } from '@/lib/content-engine/lifestyle-layout'
import type { GalleryMediaFilter, GalleryQcFilter, GalleryStateFilter } from '@/lib/creative-studio/gallery-query'
import { reelCostBdt } from '@/lib/creative-studio/video-recipes'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'react-hot-toast'

import {
  downloadStudioAsset,
  getStudioStatusMeta,
  StudioEmptyState,
  StudioErrorState,
  StudioLoadingState,
  StudioStatusBadge,
} from '@/agent/components/creative-studio/StudioUi'
import { VideoFinishPanel } from '@/agent/components/creative-studio/VideoStudioView'

const isPendingStatus = (s: string) => s === 'approved' || s === 'pending' || s === 'processing'
const isFailedStatus = (s: string) => s === 'failed' || s === 'error' || s === 'rejected'

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']
const toBanglaDigits = (n: number) =>
  String(n)
    .split('')
    .map((c) => (c >= '0' && c <= '9' ? BN_DIGITS[+c] : c))
    .join('')

/**
 * Generating tile — replaces the plain spinner. A percentage climbs 1→~95%
 * (eased by elapsed time; it never fakes 100% — that only lands when the real
 * image arrives) while a coral fill rises from the bottom and a light shimmer
 * sweeps across, so the tile visibly "fills up" as the render progresses.
 */
function GeneratingTile({ createdAt, label = 'তৈরি হচ্ছে…' }: { createdAt: string; label?: string }) {
  const [pct, setPct] = useState(3)
  useEffect(() => {
    const start = new Date(createdAt).getTime() || Date.now()
    // Typical render ~38s; approach 95% asymptotically and hold — completion snaps to 100.
    const EST = 38_000
    const id = setInterval(() => {
      const elapsed = Date.now() - start
      const target = 95 * (1 - Math.exp(-elapsed / EST))
      setPct((p) => (target > p ? p + (target - p) * 0.25 : p))
    }, 120)
    return () => clearInterval(id)
  }, [createdAt])

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* rising fill */}
      <div
        className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#E07A5F]/45 via-[#E07A5F]/20 to-[#E07A5F]/5 transition-[height] duration-200 ease-out"
        style={{ height: `${pct}%` }}
      />
      {/* fill top edge glow */}
      <div
        className="absolute inset-x-0 h-[2px] bg-[#E07A5F]/70 shadow-[0_0_10px_2px_rgba(224,122,95,0.5)] transition-[bottom] duration-200 ease-out"
        style={{ bottom: `${pct}%` }}
      />
      {/* shimmer sweep */}
      <motion.div
        className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/12 to-transparent"
        initial={{ x: '-140%' }}
        animate={{ x: '340%' }}
        transition={{ duration: 1.7, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* number */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className="text-[28px] font-extrabold leading-none tabular-nums text-cream drop-shadow">
          {toBanglaDigits(Math.round(pct))}%
        </span>
        <span className="text-[10px] font-medium text-muted">{label}</span>
      </div>
    </div>
  )
}

export function GalleryView() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [mediaFilter, setMediaFilter] = useState<GalleryMediaFilter>('all')
  const [stateFilter, setStateFilter] = useState<GalleryStateFilter>('all')
  const [qcFilter, setQcFilter] = useState<GalleryQcFilter>('all')
  const [includeTest, setIncludeTest] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  // Full-screen lightbox (complaint: clicking an image opened nothing).
  const [selected, setSelected] = useState<GalleryItem | null>(null)
  // When a branded variant exists, show it by default in the viewer.
  const [showBranded, setShowBranded] = useState(true)
  // Per-image finishing panel (logo + code + hook) inside the lightbox.
  const [showFinish, setShowFinish] = useState(false)
  const [themes, setThemes] = useState<string[]>(['default'])
  const [drive, setDrive] = useState<DriveStatus | null>(null)
  // CS8 — masked rescue: owner paints the fix area on a flagged artifact and
  // FLUX Fill repairs ONLY that region (never auto face/embroidery repaint).
  const [rescueItem, setRescueItem] = useState<GalleryItem | null>(null)
  const [rescueRunning, setRescueRunning] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const handleRescueRun = useCallback(
    async (r: MaskEditorResult) => {
      if (!rescueItem?.storagePath) return
      setRescueRunning(true)
      try {
        const uploaded = await uploadFillMask(r.maskBlob, rescueItem.storagePath)
        const result = await runStudioJob({
          mode: 'edit',
          sourceImagePath: rescueItem.storagePath,
          maskPath: uploaded.maskPath,
          maskPreset: r.preset,
          prompt: r.detail,
          baseWidth: uploaded.width,
          baseHeight: uploaded.height,
        })
        toast.success(`${result.message} · আনুমানিক $${uploaded.estimatedCostUsd.toFixed(2)}`)
        setRescueItem(null)
        setSelected(null)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Run failed')
      } finally {
        setRescueRunning(false)
      }
    },
    [rescueItem],
  )
  const openItem = useCallback((item: GalleryItem) => {
    setShowBranded(Boolean(item.brandedUrl))
    setShowFinish(false)
    setSelected(item)
  }, [])

  useEffect(() => {
    void fetchBrandStatus()
      .then((s) => setThemes(s.themes?.length ? s.themes : ['default']))
      .catch(() => {})
    void fetchDriveStatus()
      .then(setDrive)
      .catch(() => {})
  }, [])

  const onDisconnectDrive = useCallback(async () => {
    try {
      await disconnectDrive()
      setDrive((d) => (d ? { ...d, connected: false, email: null, connectedAt: null } : d))
    } catch {
      /* ignore — UI stays as-is */
    }
  }, [])

  // After finishing: attach the framed copy to the selected item + the grid so the
  // "Logo সহ" toggle appears and survives a reload.
  const applyFinished = useCallback((itemId: string, framedUrl: string) => {
    setSelected((s) => (s && s.id === itemId ? { ...s, brandedUrl: framedUrl } : s))
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, brandedUrl: framedUrl } : it)))
    setShowBranded(true)
    setShowFinish(false)
  }, [])

  const galleryQuery = useMemo(
    () => ({
      media: mediaFilter,
      state: stateFilter,
      qc: qcFilter,
      query: searchQuery,
      includeTest,
    }),
    [includeTest, mediaFilter, qcFilter, searchQuery, stateFilter],
  )

  const loadFirstPage = useCallback(
    async (preserveLoadedPages = false) => {
      if (!preserveLoadedPages) setLoading(true)
      setLoadError(null)
      try {
        const data = await fetchGallery(galleryQuery)
        setItems((previous) => {
          if (!preserveLoadedPages) return data.items
          const freshIds = new Set(data.items.map((item) => item.id))
          return [...data.items, ...previous.filter((item) => !freshIds.has(item.id))]
        })
        setSelected((current) => (current ? (data.items.find((item) => item.id === current.id) ?? current) : null))
        setTotal(data.total)
        if (!preserveLoadedPages) {
          setNextCursor(data.nextCursor)
          setHasMore(data.hasMore)
        }
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Gallery লোড করা যায়নি।')
      } finally {
        if (!preserveLoadedPages) setLoading(false)
      }
    },
    [galleryQuery],
  )

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadError(null)
    try {
      const data = await fetchGallery({ ...galleryQuery, cursor: nextCursor })
      setItems((previous) => {
        const existingIds = new Set(previous.map((item) => item.id))
        return [...previous, ...data.items.filter((item) => !existingIds.has(item.id))]
      })
      setTotal(data.total)
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'আরও Creative লোড করা যায়নি।')
    } finally {
      setLoadingMore(false)
    }
  }, [galleryQuery, loadingMore, nextCursor])

  // How many renders are still in flight — drives the "generating" banner and
  // whether we keep polling at all (poll fast while pending, stop when done so
  // we're not re-signing every URL forever).
  const pendingCount = items.filter((i) => isPendingStatus(i.status)).length

  useEffect(() => {
    void loadFirstPage(false)
  }, [loadFirstPage])

  // Poll ONLY while something is rendering. 4s while pending (snappier than the
  // old fixed 8s), then stop — finished images don't need constant re-fetching.
  useEffect(() => {
    if (pendingCount === 0) return
    const t = window.setInterval(() => void loadFirstPage(true), 4000)
    return () => window.clearInterval(t)
  }, [pendingCount, loadFirstPage])

  return (
    <div className="px-3 py-3 pb-28">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">Gallery</h2>
          <p className="text-[10px] text-muted">
            {total}টি ফলাফল · {items.length}টি দেখা যাচ্ছে
          </p>
        </div>
        <button type="button" onClick={() => void loadFirstPage(false)} className="text-[11px] font-semibold text-[#E07A5F]">
          রিফ্রেশ
        </button>
      </div>

      <div className="mb-3 space-y-2 rounded-xl border border-border-subtle bg-card/60 p-2.5">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Product code, নাম বা mode খুঁজুন"
          className="w-full rounded-lg border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream placeholder:text-muted/60"
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-[9px] font-semibold text-muted">
            ধরন
            <select
              value={mediaFilter}
              onChange={(event) => setMediaFilter(event.target.value as GalleryMediaFilter)}
              className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[11px] text-cream"
            >
              <option value="all">সব</option>
              <option value="image">ছবি</option>
              <option value="video">ভিডিও</option>
              <option value="audio">অডিও</option>
            </select>
          </label>
          <label className="space-y-1 text-[9px] font-semibold text-muted">
            অবস্থা
            <select
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value as GalleryStateFilter)}
              className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[11px] text-cream"
            >
              <option value="all">সব</option>
              <option value="ready">Ready</option>
              <option value="qc_failed">QC ফেল</option>
              <option value="draft">Draft</option>
              <option value="processing">তৈরি হচ্ছে</option>
              <option value="failed">ব্যর্থ</option>
            </select>
          </label>
          <label className="space-y-1 text-[9px] font-semibold text-muted">
            QC
            <select
              value={qcFilter}
              onChange={(event) => setQcFilter(event.target.value as GalleryQcFilter)}
              className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[11px] text-cream"
            >
              <option value="all">সব</option>
              <option value="pass">পাস</option>
              <option value="fail">ফেল</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-[10px] text-muted">
          <input
            type="checkbox"
            checked={includeTest}
            onChange={(event) => setIncludeTest(event.target.checked)}
            className="h-3.5 w-3.5 accent-[#E07A5F]"
          />
          টেস্ট/E2E Creative দেখুন
        </label>
      </div>

      {loadError && (
        <div className="mb-3">
          <StudioErrorState message={loadError} onRetry={() => void loadFirstPage(false)} />
        </div>
      )}

      {/* Google Drive archive status. When connected, the worker auto-uploads
          gallery originals to the owner's own Drive (month folders) and frees
          Supabase space — files stay safe in his 400GB Drive. */}
      {drive?.configured &&
        (drive.connected ? (
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] px-3 py-2.5">
            <span className="text-sm">☁️</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-emerald-300">Google Drive যুক্ত — ছবি/ভিডিও অটো সেভ হচ্ছে</p>
              {drive.email && <p className="truncate text-[10px] text-emerald-400/70">{drive.email}</p>}
            </div>
            <button
              type="button"
              onClick={() => void onDisconnectDrive()}
              className="shrink-0 text-[11px] font-semibold text-muted hover:text-white"
            >
              বিচ্ছিন্ন করুন
            </button>
          </div>
        ) : (
          <a
            href={connectDriveUrl()}
            className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] px-3 py-2.5"
          >
            <span className="text-sm">☁️</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-[#E07A5F]">Google Drive যুক্ত করুন</p>
              <p className="truncate text-[10px] text-[#E07A5F]/70">ছবি/ভিডিও আপনার Drive-এ অটো সেভ + জায়গা খালি রাখুন</p>
            </div>
            <span className="shrink-0 rounded-lg bg-[#E07A5F] px-2.5 py-1 text-[11px] font-bold text-white">যুক্ত করুন</span>
          </a>
        ))}

      {/* "Generation started / in progress" banner — fixes "kono bujhar way nai".
          Shows a live count of renders still cooking so the owner KNOWS work is
          happening after he hits Run. */}
      {pendingCount > 0 && (
        <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/[0.07] px-3 py-2.5">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#E07A5F]/30 border-t-[#E07A5F]" />
          <span className="text-[12px] font-semibold text-[#E07A5F]">{pendingCount}টি ছবি/ভিডিও তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে বস</span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <StudioLoadingState label="Gallery লোড হচ্ছে…" />
      ) : items.length === 0 ? (
        <StudioEmptyState title="এই filter-এ কোনো Creative নেই।" detail="Studio থেকে নতুন কাজ চালাতে পারেন।" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {items.map((item) => {
              const isVideo = item.storagePath?.endsWith('.mp4') || item.type === 'video_gen' || item.type === 'video_edit'
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
                  className="overflow-hidden st-card text-left shadow-sm transition-transform active:scale-[0.98]"
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
                        <motion.div
                          className="h-full w-full"
                          initial={{
                            clipPath: 'inset(100% 0% 0% 0%)',
                            opacity: 0.4,
                          }}
                          animate={{
                            clipPath: 'inset(0% 0% 0% 0%)',
                            opacity: 1,
                          }}
                          transition={{
                            duration: 0.7,
                            ease: [0.22, 1, 0.36, 1],
                          }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={item.thumbUrl ?? item.previewUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                        </motion.div>
                      )
                    ) : pending ? (
                      <GeneratingTile createdAt={item.createdAt} label={isVideo ? 'ভিডিও হচ্ছে…' : 'তৈরি হচ্ছে…'} />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 p-2 text-center">
                        {failed ? (
                          <span className="flex flex-col items-center gap-1.5">
                            <span className="text-[10px] font-medium text-red-400">
                              ব্যর্থ
                              {item.error ? ` · ${item.error.slice(0, 40)}` : ''}
                            </span>
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation()
                                void retryStudioJob(item.id)
                                  .then(() => {
                                    toast.success('আবার চালানো হচ্ছে, বস')
                                    void loadFirstPage(true)
                                  })
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
                      {/* CS6/CS7/CS9 — show the exact engine, not just the vendor */}
                      {item.engine === 'fal_idm_vton'
                        ? 'IDM ⚠'
                        : item.engine === 'fal_fashn_v16'
                          ? 'FAL FASHN'
                          : item.engine === 'fal_flux_fill'
                            ? 'FLUX FILL'
                            : item.engine === 'grok-imagine-image-quality'
                              ? 'GROK IMAGINE'
                              : item.engine === 'gpt-image-2'
                                ? 'GPT IMAGE 2'
                                : item.engine === 'seedream-5.0-pro'
                                  ? 'SEEDREAM 5'
                                  : item.engine?.startsWith('gemini-')
                                    ? 'GEMINI IMAGE'
                            : item.provider === 'family_composite'
                              ? '🛡 COMPOSITE'
                              : item.provider}
                    </span>
                    {item.brandedUrl && (
                      <span className="absolute right-1.5 top-1.5 rounded-md bg-[#E07A5F]/90 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                        Branded
                      </span>
                    )}
                    <StudioStatusBadge {...getStudioStatusMeta(item.assetState)} className="absolute bottom-1.5 right-1.5" />
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
          {hasMore && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="mt-3 w-full rounded-xl border border-border-subtle bg-card/70 py-2.5 text-[12px] font-bold text-cream disabled:opacity-50"
            >
              {loadingMore ? 'লোড হচ্ছে…' : `আরও দেখুন (${Math.max(0, total - items.length)}টি বাকি)`}
            </button>
          )}
        </>
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
              <div
                onClick={(e) => e.stopPropagation()}
                className="flex w-[min(92vw,420px)] flex-col items-center gap-3 rounded-2xl bg-black/70 p-5 ring-1 ring-white/15"
              >
                <span className="text-4xl">🎵</span>
                <p className="text-center text-[12px] text-white/85">{selected.summary}</p>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={selected.previewUrl} controls autoPlay className="w-full" />
                <button
                  type="button"
                  onClick={() => downloadStudioAsset(selected.previewUrl, `alma-${selected.id}.mp3`)}
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

            {/* CS6 — truthful engine lineage (fal VTON runs): engine, request id,
                seed, latency, actual cost + research-only badge */}
            {selected.engine && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] flex max-w-[70vw] flex-wrap items-center gap-1.5"
              >
                <span className="rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-bold text-white ring-1 ring-white/25">
                  {selected.engine === 'fal_idm_vton'
                    ? 'IDM-VTON'
                    : selected.engine === 'fal_fashn_v16'
                      ? 'Fal FASHN v1.6'
                      : selected.engine === 'fal_flux_fill'
                        ? 'FLUX Fill'
                        : selected.engine}
                </span>
                {selected.researchOnly && (
                  <span className="rounded-full bg-amber-500/90 px-2.5 py-1 text-[10px] font-bold text-white">⚠ পরীক্ষামূলক</span>
                )}
                {typeof selected.seed === 'number' && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/85">seed {selected.seed}</span>
                )}
                {typeof selected.latencyMs === 'number' && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/85">
                    {Math.round(selected.latencyMs / 100) / 10}s
                  </span>
                )}
                {typeof selected.costUsd === 'number' && selected.costUsd > 0 && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/85">${selected.costUsd.toFixed(3)}</span>
                )}
                {selected.requestId && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/60" title={selected.requestId}>
                    req {selected.requestId.slice(0, 8)}
                  </span>
                )}
                {selected.qc?.flagged && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-amber-300">{selected.qc.flagged}</span>
                )}
                {selected.referenceReceipt && (
                  <span
                    className={cn(
                      'rounded-full px-2 py-1 text-[10px] font-bold',
                      selected.referenceReceipt.allRequiredSent
                        && selected.referenceReceipt.sentCount === selected.referenceReceipt.expectedCount
                        ? 'bg-emerald-500/80 text-white'
                        : 'bg-red-500/90 text-white',
                    )}
                  >
                    refs {selected.referenceReceipt.sentCount}/{selected.referenceReceipt.expectedCount}
                    {selected.referenceReceipt.roles.length ? ` · ${selected.referenceReceipt.roles.join(' + ')}` : ''}
                  </span>
                )}
                {/* CS10 — plain-Bangla QC/protection summary */}
                {selected.qcDetailsBn && (
                  <span className="w-full rounded-lg bg-black/50 px-2.5 py-1 text-[10px] leading-snug text-white/85">
                    {selected.qcDetailsBn}
                  </span>
                )}
              </div>
            )}
            {/* CS9/CS10 — composites carry no engine field; still show details */}
            {!selected.engine && selected.qcDetailsBn && (
              <div onClick={(e) => e.stopPropagation()} className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] max-w-[70vw]">
                <span className="rounded-lg bg-black/50 px-2.5 py-1 text-[10px] leading-snug text-white/85">{selected.qcDetailsBn}</span>
              </div>
            )}
            {selected.assetState === 'qc_failed' && (
              <div
                onClick={(event) => event.stopPropagation()}
                className="absolute bottom-[calc(5.25rem+env(safe-area-inset-bottom))] left-1/2 w-[min(90vw,460px)] -translate-x-1/2 rounded-xl border border-amber-300/30 bg-amber-500/90 px-3 py-2 text-center text-[11px] font-bold text-black shadow-xl"
              >
                QC ফেল — Download করে পরীক্ষা করতে পারবেন; Publish, Finishing বা Reel-এর আগে Repair/Retry করে QC পাস করান।
              </div>
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
                {selected.storagePath && selected.publishable && (
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
                  onClick={() =>
                    downloadStudioAsset((showBranded && selected.brandedUrl) || selected.previewUrl, `alma-${selected.id}.jpg`)
                  }
                  className="rounded-full bg-white/15 px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25 backdrop-blur-md"
                >
                  ডাউনলোড
                </button>
                {/* CS8 — masked rescue for finished images (owner paints, Fill repairs) */}
                {selected.status === 'executed' && selected.storagePath && selected.type === 'image_gen' && (
                  <button
                    type="button"
                    onClick={() => setRescueItem(selected)}
                    className="rounded-full bg-white/15 px-4 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25 backdrop-blur-md"
                  >
                    🎯 মাস্ক এঁকে ঠিক করুন
                  </button>
                )}
                {/* CS4: ভালো/বাদ → deterministic scene weighting */}
                {selected.status === 'executed' && (
                  <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 ring-1 ring-white/20 backdrop-blur-md">
                    {(['good', 'bad'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          void sendItemFeedback(selected.id, v)
                            .then((r) =>
                              toast.success(r.weighted ? (v === 'good' ? 'এই ধরনের সিন বেশি আসবে' : 'এই সিন কম আসবে') : 'নোট করা হলো'),
                            )
                            .catch(() => toast.error('হয়নি'))
                        }}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-[12px] font-bold',
                          v === 'good' ? 'bg-[#81B29A] text-white' : 'bg-white/15 text-white',
                        )}
                      >
                        {v === 'good' ? '👍 ভালো' : '👎 বাদ'}
                      </button>
                    ))}
                  </div>
                )}
                {/* CS4: AI-generated brand model → save into the Models library */}
                {selected.modelCreator && selected.publishable && selected.storagePath && (
                  <button
                    type="button"
                    onClick={() => {
                      void saveModel({
                        id: `brand-${selected.modelCreator}`,
                        name: `ALMA ${selected.modelCreator}`,
                        imagePath: selected.storagePath!,
                        role: selected.modelCreator!,
                      })
                        .then(() => toast.success('মডেল লাইব্রেরিতে সেভ হয়েছে, বস'))
                        .catch((err) => toast.error(err instanceof Error ? err.message : 'সেভ হয়নি'))
                    }}
                    className="rounded-full bg-[#81B29A] px-5 py-2 text-[13px] font-semibold text-white ring-1 ring-white/25"
                  >
                    ✅ মডেল হিসেবে সেভ ({selected.modelCreator})
                  </button>
                )}
                {/* V4: one-tap reel from any finished studio image — the family
                    merge becomes a moving reel; 16/24s = multi-clip Veo chain */}
                {selected.publishable && selected.storagePath && (
                  <div className="flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 ring-1 ring-white/20 backdrop-blur-md">
                    <span className="pl-1 text-[11px] font-semibold text-white/80">রিল:</span>
                    {[6, 16, 24].map((d) => {
                      const cost = d >= 16 ? reelCostBdt(8) * Math.round(d / 8) : reelCostBdt(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => {
                            void runStudioJob({
                              mode: 'image_to_video',
                              sourceImagePath: selected.storagePath ?? undefined,
                              sourcePendingActionId: selected.id,
                              durationSec: d,
                            })
                              .then(() => toast.success(`${d}s রিল তৈরি হচ্ছে (~৳${cost}) — Gallery-তে আসবে, বস`))
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
                            .then(() => toast.success('কভার সেট হয়েছে, বস'))
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
                  {selected.publishable && (
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
                    onClick={() =>
                      downloadStudioAsset((showBranded && selected.brandedUrl) || selected.previewUrl, `alma-${selected.id}.mp4`)
                    }
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
                        void loadFirstPage(true)
                        toast.success('টেমপ্লেট বসে গেছে — "টেমপ্লেট সহ" ভার্সন দেখুন, বস')
                      }}
                    />
                  </div>
                )}
              </div>
            ) : null}

            {/* Finishing panel — per-image code + hook, applied with the real brand frame */}
            {showFinish && selected.storagePath && selected.publishable && (
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

      {/* CS8 — masked rescue editor on a finished artifact */}
      <AnimatePresence>
        {rescueItem?.previewUrl && (
          <MaskEditor
            imageUrl={rescueItem.previewUrl}
            running={rescueRunning}
            onCancel={() => setRescueItem(null)}
            onRun={(r) => void handleRescueRun(r)}
          />
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
export function FinishPanel({
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
      toast.error(isLifestyle ? 'মূল লেখাটা (headline) দিন বস' : 'একটা hook লেখা লাগবে বস')
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
        layout: isLifestyle ? (layout ?? undefined) : undefined,
      })
      toast.success('ফিনিশিং হয়ে গেছে বস ✅')
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
      toast.error('মূল লেখাটা (headline) দিন বস')
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
                <option key={t} value={t}>
                  {themeLabel[t] ?? t}
                </option>
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

/**
 * CS14 — Avatar sheet: up to 10 different-angle photos of a saved model.
 * "Avatar বানাও" queues the worker build — free identity sheet + optional
 * Grok canonical portrait (~$0.07). Once built, every render that uses this
 * model automatically rides the avatar references.
 */

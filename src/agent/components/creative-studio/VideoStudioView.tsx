'use client'

import {
  deleteMusicTrack,
  deleteStudioVideo,
  fetchMusicTracks,
  fetchStudioVideos,
  fetchVideoEditSource,
  fetchVideoJob,
  finishVideo,
  partiallyFinishVideo,
  runVideoRecipe,
  uploadMusicTrack,
  uploadStudioVideo,
  type StudioMusicTrack,
  type StudioVideoUpload,
  type VideoFinishTemplates,
  type VideoJobStatus,
} from '@/agent/components/creative-studio/studio-api'
import { TimelineLite } from '@/agent/components/creative-studio/TimelineLite'
import { TranscriptEditor } from '@/agent/components/creative-studio/TranscriptEditor'
import {
  AUDIO_MODES,
  MUSIC_VIBES,
  VIDEO_ASPECTS,
  VIDEO_RECIPES,
  VOICEOVER_MAX_CHARS,
  type VideoAudioMode,
} from '@/lib/creative-studio/video-recipes'
import { cn } from '@/lib/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'
import {
  createDefaultVideoEditContract,
  type VideoEditContract,
} from '@/lib/creative-studio/video-edit-contract'

import { VideoSvg } from '@/agent/components/creative-studio/StudioUi'

export function VideoStudioView({ onOpenGallery, onOpenStudio }: { onOpenGallery: () => void; onOpenStudio: () => void }) {
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
    void fetchMusicTracks()
      .then(setTracks)
      .catch(() => {})
  }, [])

  const loadUploads = useCallback(async () => {
    try {
      const list = await fetchStudioVideos()
      setUploads(list)
    } catch {
      /* list stays as-is */
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    void loadUploads()
  }, [loadUploads])

  // Poll running jobs every 4s for ধাপ N/M progress (same rhythm as the gallery).
  const activeJobIds = jobs
    .filter((j) => !j.status || j.status.status === 'approved' || j.status.status === 'pending')
    .map((j) => j.id)
    .join(',')
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
      toast.success('ভিডিও আপলোড হয়েছে, বস')
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
        ...res.jobs.map((j) => ({
          id: j.pendingActionId,
          label: j.label,
          status: null,
        })),
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
          <p className="text-[11px] text-muted">ভিডিওর সব কাজ এক জায়গায় — ৩টা পথ:</p>
        </div>

        {/* video hub — every entry point in ONE place (owner 2026-07-18: the
            three video paths were scattered and impossible to find) */}
        <div className="grid grid-cols-1 gap-2">
          <button type="button" onClick={onOpenGallery} className="st-card flex items-center gap-3 p-3 text-left">
            <span className="text-lg">🖼️</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-cream">ছবি থেকে রিল</span>
              <span className="block text-[10px] text-muted">গ্যালারির যেকোনো ছবি খুলে ৬s/১৬s/২৪s বাটন চাপুন (Veo)</span>
            </span>
            <span className="shrink-0 text-[11px] font-semibold text-[#E07A5F]">গ্যালারি →</span>
          </button>
          <button type="button" onClick={onOpenStudio} className="st-card flex items-center gap-3 p-3 text-left">
            <span className="text-lg">🛍️</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-cream">নতুন প্রোডাক্টের রিল</span>
              <span className="block text-[10px] text-muted">স্টুডিওর Auto মোডে &quot;🎬 ছোট রিলও বানাও&quot; টগল অন করুন</span>
            </span>
            <span className="shrink-0 text-[11px] font-semibold text-[#E07A5F]">স্টুডিও →</span>
          </button>
          <div className="st-card flex items-center gap-3 p-3">
            <span className="text-lg">🎞️</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-cream">নিজের ভিডিও এডিট</span>
              <span className="block text-[10px] text-muted">নিচে আপলোড করুন — রেসিপি বাছলেই কাট/ক্যাপশন/মিউজিকসহ রেডি রিল</span>
            </span>
          </div>
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
          <div className="st-card p-3">
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
        ) : (
          uploads.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-muted">আপলোড করা শুট</p>
              {uploads.map((up) => (
                <div
                  key={up.id}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2.5',
                    selected?.id === up.id ? 'border-[#E07A5F]/60 bg-[#E07A5F]/[0.08]' : 'border-border-subtle bg-card/80',
                  )}
                >
                  <button type="button" onClick={() => setSelected(up)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span
                      className={cn(
                        'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                        selected?.id === up.id ? 'st-chip-on' : 'st-chip',
                      )}
                    >
                      <VideoSvg className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-cream">{up.name}</span>
                      <span className="block text-[10px] text-muted">
                        {fmtSize(up.sizeBytes)} · {new Date(up.uploadedAt).toLocaleDateString('en-BD')}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(up)}
                    aria-label="মুছুন"
                    className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-muted hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )
        )}

        {/* Recipe picker — hard presets, no prompts */}
        {selected && (
          <div className="space-y-3 st-card p-3">
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
                    className={cn('rounded-lg px-3.5 py-1.5 text-[12px] font-semibold', targets.includes(t) ? 'st-chip-on' : 'st-chip')}
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
                    className={cn('rounded-lg px-3 py-1.5 text-[11px] font-semibold', aspect === a.id ? 'st-chip-on' : 'st-chip')}
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
                <input
                  type="checkbox"
                  checked={captions}
                  onChange={(e) => setCaptions(e.target.checked)}
                  className="h-4 w-4 accent-[#E07A5F]"
                />
              </label>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted">সাউন্ড</p>
                <div className="flex gap-1.5">
                  {AUDIO_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setAudioMode(m.id)}
                      className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', audioMode === m.id ? 'st-chip-on' : 'st-chip')}
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
                <p className="mb-1 text-[11px] font-semibold text-muted">
                  ভয়েসওভার (ঐচ্ছিক — আপনার লেখা লাইন, আপনার এজেন্টের বাংলা ভয়েসে)
                </p>
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
                <input
                  type="checkbox"
                  checked={stings}
                  onChange={(e) => setStings(e.target.checked)}
                  className="h-4 w-4 accent-[#E07A5F]"
                />
              </label>

              <label className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-cream">
                  AI হাইলাইট সাজেশন <span className="text-[10px] text-muted">(বিটা)</span>
                </span>
                <input
                  type="checkbox"
                  checked={aiAssist}
                  onChange={(e) => setAiAssist(e.target.checked)}
                  className="h-4 w-4 accent-[#E07A5F]"
                />
              </label>
            </div>

            <button
              type="button"
              disabled={running || targets.length === 0}
              onClick={() => void handleRun()}
              className="st-btn w-full py-3 text-[13px]"
            >
              {running ? 'শুরু হচ্ছে…' : `রিল বানাও (${targets.map((t) => `${t}s`).join(' + ')})`}
            </button>
          </div>
        )}

        {/* Music library — owner-approved beds only (Islamic guardrail) */}
        <div className="st-card p-3">
          <button type="button" onClick={() => setShowMusicLib((v) => !v)} className="flex w-full items-center justify-between">
            <span className="text-[12px] font-bold text-cream">🎵 মিউজিক লাইব্রেরি ({tracks.length})</span>
            <span className="text-[11px] text-muted">{showMusicLib ? '▲' : '▼'}</span>
          </button>
          {showMusicLib && <MusicLibrary tracks={tracks} onChanged={setTracks} />}
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
                <div key={j.id} className="flex items-center gap-2.5 st-card px-3 py-2.5">
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
                        ? (st?.error ?? 'ব্যর্থ হয়েছে')
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
export function VideoFinishPanel({ pendingActionId, onDone }: { pendingActionId: string; onDone: () => void }) {
  const [panelMode, setPanelMode] = useState<'templates' | 'timeline'>('timeline')
  const [price, setPrice] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [cta, setCta] = useState('')
  const [days, setDays] = useState('')
  const [watermark, setWatermark] = useState(true)
  const [endCard, setEndCard] = useState(true)
  const [state, setState] = useState<'idle' | 'queued' | 'working'>('idle')
  const [progress, setProgress] = useState('')
  const [editContract, setEditContract] = useState<VideoEditContract>(() => createDefaultVideoEditContract(15))
  const [editLoading, setEditLoading] = useState(true)

  useEffect(() => {
    let live = true
    void fetchVideoEditSource(pendingActionId)
      .then((source) => {
        if (!live) return
        setEditContract(source.editContract ?? createDefaultVideoEditContract(source.durationSec))
      })
      .catch(() => {})
      .finally(() => {
        if (live) setEditLoading(false)
      })
    return () => { live = false }
  }, [pendingActionId])

  const pollQueuedJob = useCallback((jobId: string, failureMessage: string) => {
    const poll = window.setInterval(() => {
      void fetchVideoJob(jobId)
        .then((job) => {
          if (job.videoProgress) setProgress(`ধাপ ${job.videoProgress.step}/${job.videoProgress.total}: ${job.videoProgress.labelBn}`)
          if (job.status === 'executed') {
            window.clearInterval(poll)
            onDone()
          } else if (job.status === 'failed') {
            window.clearInterval(poll)
            setState('idle')
            toast.error(job.error ?? failureMessage)
          }
        })
        .catch(() => {})
    }, 4000)
  }, [onDone])

  const submit = useCallback(async () => {
    const templates: VideoFinishTemplates = {}
    if (price.trim()) templates.pricePop = { price: price.trim() }
    if (code.trim())
      templates.lowerThird = {
        code: code.trim(),
        name: name.trim() || undefined,
      }
    if (watermark) templates.logoWatermark = true
    if (endCard)
      templates.endCard = {
        cta: cta.trim() || undefined,
        code: code.trim() || undefined,
        price: price.trim() || undefined,
      }
    if (Number(days) > 0) templates.countdown = { days: Number(days) }

    setState('queued')
    try {
      const res = await finishVideo(pendingActionId, templates)
      setState('working')
      pollQueuedJob(res.pendingActionId, 'টেমপ্লেট বসানো ব্যর্থ হয়েছে')
    } catch (err) {
      setState('idle')
      toast.error(err instanceof Error ? err.message : 'শুরু করা যায়নি')
    }
  }, [pendingActionId, price, code, name, cta, days, watermark, endCard, pollQueuedJob])

  const submitTimeline = useCallback(async () => {
    if (editContract.rerender.length === 0) {
      toast.error('অন্তত একটি track বাছুন')
      return
    }
    setState('queued')
    try {
      const res = await partiallyFinishVideo(pendingActionId, editContract)
      setState('working')
      setProgress('বাছাই করা track render হচ্ছে…')
      pollQueuedJob(res.pendingActionId, 'Timeline edit ব্যর্থ হয়েছে')
    } catch (err) {
      setState('idle')
      toast.error(err instanceof Error ? err.message : 'Timeline edit শুরু করা যায়নি')
    }
  }, [editContract, pendingActionId, pollQueuedJob])

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
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-white/[0.06] p-1">
            <button
              type="button"
              onClick={() => setPanelMode('timeline')}
              className={cn('rounded-md px-2 py-1.5 text-[11px] font-semibold', panelMode === 'timeline' ? 'bg-[#E07A5F] text-white' : 'text-white/60')}
            >
              ✂️ Timeline
            </button>
            <button
              type="button"
              onClick={() => setPanelMode('templates')}
              className={cn('rounded-md px-2 py-1.5 text-[11px] font-semibold', panelMode === 'templates' ? 'bg-[#E07A5F] text-white' : 'text-white/60')}
            >
              🎞️ Templates
            </button>
          </div>

          {panelMode === 'timeline' ? (
            editLoading ? (
              <div className="h-28 animate-pulse rounded-xl bg-white/[0.06]" />
            ) : (
              <>
                <TimelineLite value={editContract} onChange={setEditContract} />
                <TranscriptEditor value={editContract} onChange={setEditContract} />
                <p className="rounded-lg bg-[#81B29A]/10 px-2.5 py-2 text-[10px] text-[#b8e0cf]">
                  Source regenerate হবে না। Trim/crop local ffmpeg-এ; caption/audio/cover আলাদা track হিসেবে partial render হবে। খরচ ৳0।
                </p>
                <button
                  type="button"
                  disabled={state !== 'idle' || editContract.rerender.length === 0}
                  onClick={() => void submitTimeline()}
                  className="st-btn w-full py-2.5 text-[13px]"
                >
                  {state === 'queued' ? 'শুরু হচ্ছে…' : 'বাছাই করা track render করুন · ৳0'}
                </button>
              </>
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="দাম (৳)" className={inputCls} />
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="প্রোডাক্ট কোড" className={inputCls} />
              </div>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="প্রোডাক্টের নাম (ঐচ্ছিক)" className={inputCls} />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={cta}
                  onChange={(e) => setCta(e.target.value)}
                  placeholder="CTA (ডিফল্ট: অর্ডার করতে ইনবক্স করুন)"
                  className={inputCls}
                />
                <input
                  value={days}
                  onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
                  placeholder="অফার শেষ হতে দিন"
                  className={inputCls}
                />
              </div>
              <div className="flex items-center gap-4 py-0.5">
                <label className="flex items-center gap-1.5 text-[12px] text-white/85">
                  <input
                    type="checkbox"
                    checked={watermark}
                    onChange={(e) => setWatermark(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#E07A5F]"
                  />
                  লোগো ওয়াটারমার্ক
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-white/85">
                  <input
                    type="checkbox"
                    checked={endCard}
                    onChange={(e) => setEndCard(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#E07A5F]"
                  />
                  এন্ড কার্ড (CTA)
                </label>
              </div>
              <button type="button" disabled={state !== 'idle'} onClick={() => void submit()} className="st-btn w-full py-2.5 text-[13px]">
                {state === 'queued' ? 'শুরু হচ্ছে…' : 'টেমপ্লেট বসাও'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Owner-approved music beds: upload (signed direct), tag by vibe, delete. */
function MusicLibrary({ tracks, onChanged }: { tracks: StudioMusicTrack[]; onChanged: (tracks: StudioMusicTrack[]) => void }) {
  const [vibe, setVibe] = useState<string>(MUSIC_VIBES[0].id)
  const [pct, setPct] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(
    async (file: File | null) => {
      if (!file) return
      setPct(0)
      try {
        const track = await uploadMusicTrack(file, vibe, setPct)
        onChanged([track, ...tracks])
        toast.success('ট্র্যাক যোগ হয়েছে, বস')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'আপলোড ব্যর্থ')
      } finally {
        setPct(null)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [vibe, tracks, onChanged],
  )

  return (
    <div className="mt-2.5 space-y-2">
      <p className="text-[10px] text-muted">শুধু আপনার অনুমোদিত ট্র্যাকই রিলে বসে — সিস্টেম নিজে কোথাও থেকে মিউজিক আনে না।</p>
      <div className="flex items-center gap-1.5">
        {MUSIC_VIBES.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setVibe(v.id)}
            className={cn('rounded-lg px-2.5 py-1 text-[11px] font-semibold', vibe === v.id ? 'st-chip-on' : 'st-chip')}
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

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
import { FAMILY_CHAIN_LABEL_BN, type StudioEngineId } from '@/lib/creative-studio/provider-registry'
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
import MaskEditor, { type MaskEditorResult } from '@/agent/components/creative-studio/MaskEditor'
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
  setDefaultModel,
  deleteModel,
  runAutoStudioJob,
  runStudioJob,
  uploadFillMask,
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
  fetchGoldenEval,
  runGoldenEvalNow,
  type GoldenEvalSummary,
  fetchStudioHealth,
  setEngineKill,
  type StudioHealth,
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
  if (result === 'downloaded') toast.success('ডাউনলোড হয়েছে, বস')
  else if (result === 'opened') toast('ছবি নতুন ট্যাবে খোলা হলো, বস')
}

type MainView = 'studio' | 'gallery' | 'video' | 'audio' | 'library'
type StudioModel = {
  id: string
  name: string
  role: string | null
  isDefault: boolean
  imagePath?: string
  imageUrl?: string | null
}

/** Bangla label for a model role (falls back to the raw role for anything odd). */
function roleLabelBn(role: string | null): string {
  switch (role) {
    case 'single': return 'একক / নিজে'
    case 'father': return 'বাবা'
    case 'mother': return 'মা'
    case 'son': return 'ছেলে'
    case 'daughter': return 'মেয়ে'
    default: return role ?? ''
  }
}

/**
 * Reusable chooser sheet — the ONE place the owner decides which model a shot
 * uses. Lists the saved library models as a grid; optionally offers "upload new"
 * (Advanced) or a clear action. Auto reuses it without the upload option (it can
 * only run on a saved model). Used by ModelSlot (Advanced) and the Auto panel so
 * model selection is identical everywhere.
 */
function ModelChooserSheet({
  title = 'মডেল বেছে নিন',
  models,
  selectedId,
  onClose,
  onPickSaved,
  onUpload,
  onClear,
  hasChoice,
  uploadHint,
}: {
  title?: string
  models: StudioModel[]
  selectedId: string
  onClose: () => void
  onPickSaved: (id: string) => void
  onUpload?: (f: File) => void
  onClear?: () => void
  hasChoice?: boolean
  uploadHint?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        initial={{ y: 40, opacity: 0.6 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-border-subtle bg-card p-4 shadow-2xl sm:rounded-3xl"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {onUpload && (
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) { onUpload(f); onClose() }
              e.target.value = ''
            }}
          />
        )}

        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-cream">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted">✕</button>
        </div>

        {models.length > 0 ? (
          <>
            <p className="mb-2 text-[11px] font-semibold text-muted">সেভ করা মডেল থেকে</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {models.map((m) => {
                const active = selectedId === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { onPickSaved(m.id); onClose() }}
                    className={cn(
                      'relative aspect-[3/4] overflow-hidden rounded-xl border transition-all',
                      active ? 'border-[#E07A5F] ring-2 ring-[#E07A5F]/30' : 'border-border-subtle',
                    )}
                    title={`${m.name} (${roleLabelBn(m.role)})`}
                  >
                    {m.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.imageUrl} alt={m.name} className="h-full w-full object-cover" />
                    ) : (
                      <span className="grid h-full w-full place-items-center bg-bg-1 text-muted"><UserSvg className="h-6 w-6" /></span>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4">
                      <span className="block truncate text-left text-[10px] font-bold text-white">{m.name}</span>
                    </div>
                    {active && (
                      <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[#E07A5F] text-[10px] text-white shadow">✓</span>
                    )}
                  </button>
                )
              })}
            </div>
            {onUpload && (
              <div className="my-3 flex items-center gap-2 text-[10px] text-muted">
                <span className="h-px flex-1 bg-border-subtle" /> অথবা <span className="h-px flex-1 bg-border-subtle" />
              </div>
            )}
          </>
        ) : (
          <p className="mb-3 rounded-xl border border-border-subtle bg-bg-1 px-3 py-2.5 text-[11.5px] text-muted">
            লাইব্রেরিতে কোনো সেভ করা মডেল নেই। {onUpload ? 'এখন একটা ছবি আপলোড করতে পারেন, অথবা ' : ''}<b className="text-cream">লাইব্রেরি</b> ট্যাবে গিয়ে মডেল সেভ করুন।
          </p>
        )}

        {onUpload ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#E07A5F] py-3 text-[14px] font-bold text-white"
          >
            📁 নতুন ছবি আপলোড করুন
          </button>
        ) : uploadHint ? (
          <p className="text-center text-[10.5px] text-muted">{uploadHint}</p>
        ) : null}

        {onClear && hasChoice && (
          <button
            type="button"
            onClick={() => { onClear(); onClose() }}
            className="mt-2 w-full rounded-xl border border-border py-2.5 text-[12px] font-semibold text-muted"
          >
            বাছাই বাদ দিন
          </button>
        )}
      </motion.div>
    </motion.div>
  )
}

/**
 * Unified model input for Advanced. Tapping it opens the chooser SHEET that first
 * asks the owner whether to use a SAVED model or UPLOAD a new photo — instead of
 * jumping straight into the OS file picker. Saved-pick and upload are mutually
 * exclusive: choosing one clears the other.
 */
function ModelSlot({
  models,
  selectedId,
  uploadPreview,
  onPickSaved,
  onUpload,
  onClear,
  required,
}: {
  models: StudioModel[]
  selectedId: string
  uploadPreview: string | null
  onPickSaved: (id: string) => void
  onUpload: (f: File) => void
  onClear: () => void
  required?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = models.find((m) => m.id === selectedId) ?? null
  const hasChoice = Boolean(selected || uploadPreview)

  return (
    <div>
      {/* The slot — shows the current choice, or a prompt. Tap → chooser sheet. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full items-center gap-3 rounded-2xl border-2 border-dashed p-2.5 text-left transition-colors',
          hasChoice ? 'border-[#E07A5F]/30 bg-card/80' : 'border-border bg-card/80',
        )}
      >
        <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-bg-1 text-muted">
          {selected?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.imageUrl} alt={selected.name} className="h-full w-full object-cover" />
          ) : uploadPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={uploadPreview} alt="model" className="h-full w-full object-cover" />
          ) : (
            <UserSvg className="h-6 w-6" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {selected ? (
            <>
              <p className="truncate text-[14px] font-bold text-cream">{selected.name}</p>
              <p className="text-[11px] text-muted">সেভ করা মডেল · {roleLabelBn(selected.role)}</p>
            </>
          ) : uploadPreview ? (
            <>
              <p className="truncate text-[14px] font-bold text-cream">নতুন আপলোড করা ছবি</p>
              <p className="text-[11px] text-muted">ট্যাপ করে বদলান</p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-bold text-cream">
                Model{required && <span className="text-[#E07A5F]"> *</span>}
              </p>
              <p className="text-[11px] text-muted">ট্যাপ করুন — সেভ করা মডেল বা নতুন ছবি</p>
            </>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-[#E07A5F]/12 px-2.5 py-1 text-[11px] font-semibold text-[#E07A5F]">
          {hasChoice ? 'বদলান' : 'বেছে নিন'}
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <ModelChooserSheet
            models={models}
            selectedId={selectedId}
            onClose={() => setOpen(false)}
            onPickSaved={onPickSaved}
            onUpload={onUpload}
            onClear={onClear}
            hasChoice={hasChoice}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

const MODEL_ROLES = [
  { id: 'single', label: 'একক / নিজে' },
  { id: 'father', label: 'বাবা' },
  { id: 'mother', label: 'মা' },
  { id: 'son', label: 'ছেলে (৫–১২)' },
  { id: 'daughter', label: 'মেয়ে (৫–১০)' },
] as const

type FamilyRole = 'father' | 'mother' | 'son' | 'daughter'

// Which saved roles each family preset needs. The family chain resolves people
// BY ROLE from the library (not per-shot multi-select), so a preset can only run
// once every role below is saved. Drives the pre-Run checklist so missing models
// are visible up front instead of failing at Run time.
const FAMILY_REQUIRED_ROLES: Record<string, FamilyRole[]> = {
  father_son: ['father', 'son'],
  mother_son: ['mother', 'son'],
  mother_daughter: ['mother', 'daughter'],
  father_daughter: ['father', 'daughter'],
  couple: ['father', 'mother'],
  full_family: ['father', 'mother', 'son', 'daughter'],
}

/**
 * Quick add-model bottom-sheet. Self-contained: pick a photo, name it, save it to
 * the library. `lockedRole` forces the role (used by the family checklist's "add
 * son/daughter" shortcut) so the owner can't accidentally save the wrong role.
 */
function AddModelSheet({
  lockedRole,
  onClose,
  onSaved,
}: {
  lockedRole?: string
  onClose: () => void
  onSaved: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState(lockedRole ?? 'single')
  const [saving, setSaving] = useState(false)

  const onPick = (f: File) => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(f) })
    setPath(null)
    setUploading(true)
    void uploadStudioFile(f, 'model-library')
      .then((p) => setPath(p))
      .catch((err) => toast.error(String(err)))
      .finally(() => setUploading(false))
  }

  const save = async () => {
    if (!name.trim() || !path) { toast.error('নাম আর ছবি — দুটোই দরকার'); return }
    setSaving(true)
    try {
      await saveModel({
        id: name.trim().toLowerCase().replace(/\s+/g, '-'),
        name: name.trim(),
        imagePath: path,
        role,
      })
      toast.success(`মডেল "${name}" সেভ হলো`)
      if (preview) URL.revokeObjectURL(preview)
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const lockedLabel = MODEL_ROLES.find((r) => r.id === lockedRole)?.label

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => !saving && onClose()}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <motion.div
        initial={{ y: 40, opacity: 0.6 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-3xl border border-border-subtle bg-card p-4 shadow-2xl sm:rounded-3xl"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }}
        />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-cream">
            {lockedLabel ? `${lockedLabel} মডেল যোগ করুন` : 'নতুন মডেল যোগ করুন'}
          </h3>
          <button type="button" onClick={() => !saving && onClose()} className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted">✕</button>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="relative h-40 w-32 shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-border bg-bg-1"
          >
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="preview" className="h-full w-full object-cover" />
            ) : (
              <span className="grid h-full w-full place-items-center px-2 text-center text-[11px] text-muted">ট্যাপ করে ছবি দিন</span>
            )}
            {uploading && (
              <div className="absolute inset-0 grid place-items-center bg-black/40">
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              </div>
            )}
          </button>

          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <div>
              <label className="mb-1 block text-[10.5px] font-semibold text-muted">নাম</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="যেমন: Rakib"
                className="w-full rounded-xl border border-border bg-bg-1 px-3 py-2.5 text-[13px] text-cream outline-none focus:border-[#E07A5F]/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10.5px] font-semibold text-muted">ধরন</label>
              {lockedRole ? (
                <span className="inline-block rounded-full bg-[#E07A5F] px-3 py-1.5 text-[11px] font-bold text-white">{lockedLabel}</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {MODEL_ROLES.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRole(r.id)}
                      className={cn(
                        'rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                        role === r.id ? 'bg-[#E07A5F] text-white' : 'border border-border bg-bg-1 text-muted',
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={saving || uploading || !path || !name.trim()}
          onClick={() => void save()}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#E07A5F] py-3 text-[14px] font-bold text-white transition-opacity disabled:opacity-40"
        >
          {saving ? (
            <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> সেভ হচ্ছে…</>
          ) : uploading ? 'ছবি আপলোড হচ্ছে…' : 'সেভ করুন'}
        </button>
      </motion.div>
    </motion.div>
  )
}

/**
 * Pre-Run family checklist. When a family preset is active it lists the roles the
 * shot needs, marks each saved (✓ with the model's face) or missing (⚠ "যোগ করুন"),
 * so the owner sees up front what's required instead of hitting a Run-time error.
 */
function FamilyRoleChecklist({
  preset,
  models,
  onAddRole,
}: {
  preset: string
  models: StudioModel[]
  onAddRole: (role: FamilyRole) => void
}) {
  const required = FAMILY_REQUIRED_ROLES[preset]
  if (!required) return null
  const byRole = new Map(models.filter((m) => m.role).map((m) => [m.role as string, m]))
  const missing = required.filter((r) => !byRole.has(r))

  return (
    <div className="rounded-2xl border border-border-subtle bg-card/70 p-3">
      <p className="mb-2 text-[11.5px] font-semibold text-cream">
        এই ফ্যামিলি শটে যা লাগবে {missing.length === 0 ? '· সব প্রস্তুত ✅' : `· ${missing.length}টি বাকি`}
      </p>
      <div className="flex flex-col gap-1.5">
        {required.map((r) => {
          const m = byRole.get(r)
          return (
            <div key={r} className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-bg-1 text-muted">
                {m?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.imageUrl} alt={m.name} className="h-full w-full object-cover" />
                ) : (
                  <UserSvg className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-cream">{roleLabelBn(r)}</p>
                <p className="truncate text-[10px] text-muted">{m ? m.name : 'সেভ করা নেই'}</p>
              </div>
              {m ? (
                <span className="shrink-0 text-[13px] text-emerald-400">✓</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onAddRole(r)}
                  className="shrink-0 rounded-full bg-[#E07A5F] px-3 py-1.5 text-[11px] font-bold text-white"
                >
                  যোগ করুন
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// These modes carry no product image, so the Gemini fallback (which requires a
// product) can't serve them — they only render through FASHN. Gate them in the
// UI so the owner never picks a mode that will fail server-side.
const FASHN_ONLY_MODES: StudioModeId[] = ['model_swap', 'face_to_model', 'edit']

// One truthful engine-name map for the whole Studio (header badge, pickers,
// captions) — the owner must always see WHICH engine will actually run.
const ENGINE_LABELS_BN: Record<string, string> = {
  fashn: 'FASHN Pro',
  fal_fashn_v16: 'Fal FASHN v1.6',
  fal_idm_vton: 'IDM-VTON ⚠',
  gemini: 'Gemini',
}

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
    <div className="studio-shell flex h-full min-h-0 w-full overflow-hidden text-cream">
      <Toaster position="top-center" toastOptions={{ duration: 3500 }} />

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
              <p className="text-lg font-extrabold tracking-tight text-cream">ক্রিয়েটিভ স্টুডিও</p>
              <p className="text-[10px] text-muted">{config?.organization ?? 'ALMA Lifestyle'} · সব ক্রিয়েটিভ এক জায়গায়</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* A1: catalog images cross-link — one central creative place */}
            <Link href="/agent/catalog-images" className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-muted hover:text-cream">
              📸 ক্যাটালগ
            </Link>
            {config && (() => {
              // truthful badge: name the engine that will ACTUALLY run by
              // default (owner 2026-07-18: the old "FASHN Pro ready" label hid
              // that Fal FASHN v1.6 had taken over everywhere)
              const def = config.singleVtonDefault ?? 'fashn'
              const ok = def !== 'fashn' || config.fashnConfigured
              return (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    ok ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-amber-100 text-amber-800',
                  )}
                >
                  {ok ? `⚙ ${ENGINE_LABELS_BN[def] ?? def} চালু` : 'Add FASHN_API_KEY'}
                </span>
              )
            })()}
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
            {view === 'library' && (
              <motion.div key="library" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="pb-24">
                  <ModelsView />
                  <div className="mx-3 my-1 border-t border-border-subtle" />
                  <FinishingView />
                </div>
              </motion.div>
            )}
            {view === 'video' && (
              <motion.div key="video" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <VideoStudioView onOpenGallery={() => setView('gallery')} onOpenStudio={() => setView('studio')} />
              </motion.div>
            )}
            {view === 'audio' && (
              <motion.div key="audio" className="absolute inset-0 overflow-y-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <AudioLabView />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Floating iOS-style tab bar — one nav for every screen size */}
        <nav
          className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex justify-center"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="st-tabbar pointer-events-auto flex items-center gap-1 px-2 py-1.5">
            {(
              [
                ['studio', 'স্টুডিও', StudioSvg],
                ['gallery', 'গ্যালারি', GallerySvg],
                ['video', 'ভিডিও', VideoSvg],
                ['audio', 'অডিও', AudioSvg],
                ['library', 'লাইব্রেরি', UserSvg],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={cn('st-tab flex flex-col items-center gap-0.5 px-3.5 py-1.5 text-[10px] font-semibold', view === id && 'st-tab-on')}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
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
  // CS6 — single Try-On engine choice + garment placement override
  const [vtonEngine, setVtonEngine] = useState<StudioEngineId>('fashn')
  const [clothType, setClothType] = useState<'auto' | 'overall' | 'upper' | 'lower' | 'outer'>('auto')
  // CS7 — FLUX Fill precision edit
  const [maskEditorOpen, setMaskEditorOpen] = useState(false)
  const [maskRunning, setMaskRunning] = useState(false)
  // CS9 — family protected compositing opt-in (no face/garment regen merge)
  const [protectedComposite, setProtectedComposite] = useState(false)
  // CS8 — pipeline mode (bounded spend, shown under Run)
  const [pipelineMode, setPipelineMode] = useState<'preview' | 'production'>('preview')
  useEffect(() => {
    void fetchStudioSettings().then((s) => setPipelineMode(s.pipelineMode)).catch(() => {})
  }, [])
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

  // A role-based family preset is active (baba+chele etc., but NOT the full_family
  // merge which has its own two-upload UI). When active, the single-model slot is
  // replaced by the role checklist — members come from the library by role.
  const familyActive =
    !isFamilyMerge
    && (mode === 'product_to_model' || mode === 'try_on')
    && familyPreset !== 'single'
    && Boolean(FAMILY_REQUIRED_ROLES[familyPreset])
  // which role's add-model sheet is open (from the family checklist)
  const [addRoleSheet, setAddRoleSheet] = useState<FamilyRole | null>(null)

  // Any multi-person family preset (baba+chele, ma+meye, full family) must render on
  // Gemini — FASHN tryon-max is single-person only and can't place 2+ people. The
  // backend already forces this; mirror it in the UI so the Run button / provider
  // label is honest instead of saying "FASHN Pro" while Gemini actually runs.
  const isMultiPersonFamily =
    familyPreset !== 'single' && (mode === 'product_to_model' || mode === 'try_on')
  const effectiveProvider: StudioProvider = isMultiPersonFamily ? 'gemini' : provider

  // CS6 — engine picker applies ONLY to single-person Try-On. IDM/Fal engines
  // are hidden everywhere else (family, swap, face, edit, video) by design.
  const isSingleTryOn = mode === 'try_on' && familyPreset === 'single'
  const engineAvail = useMemo(() => {
    const m = new Map<string, StudioConfig['engines'][number]>()
    for (const e of config?.engines ?? []) m.set(e.id, e)
    return m
  }, [config])
  const engineSelectable = useCallback(
    (id: string) => {
      const e = engineAvail.get(id)
      return Boolean(e && e.configured && e.enabled && e.runnable)
    },
    [engineAvail],
  )
  // Owner default from settings; fall back to direct FASHN when it isn't selectable.
  useEffect(() => {
    if (!config) return
    const def = config.singleVtonDefault ?? 'fashn'
    setVtonEngine(def === 'fashn' || def === 'gemini' || engineSelectable(def) ? def : 'fashn')
  }, [config, engineSelectable])
  const idmWarning = engineAvail.get('fal_idm_vton')?.warningBn ?? null
  const VTON_ENGINE_LABELS = ENGINE_LABELS_BN

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

  const reloadModels = useCallback(async () => {
    const d = await fetchModels()
    setModels(d.models ?? [])
  }, [])

  useEffect(() => {
    void reloadModels().catch(() => {})
  }, [reloadModels])

  // Auto uses whichever model is the DEFAULT (server-side getDefaultModel). Letting
  // the owner pick a model in the Auto panel simply promotes it to default, then
  // refreshes so the card + Auto run both reflect the choice — no backend change.
  const pickAutoModel = useCallback(async (id: string) => {
    try {
      await setDefaultModel(id)
      await reloadModels()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    }
  }, [reloadModels])

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
    // Role-based family: members come from the library by role — need the product +
    // every required role saved (the checklist shows what's missing).
    if (familyActive) {
      if (modeDef.needsProduct && !productPath) return false
      const have = new Set(models.filter((m) => m.role).map((m) => m.role))
      return (FAMILY_REQUIRED_ROLES[familyPreset] ?? []).every((r) => have.has(r))
    }
    if (modeDef.needsProduct && !productPath) return false
    if (modeDef.needsModel && !modelPath && !modelId) return false
    if (modeDef.needsSource && !sourcePath) return false
    return true
  }, [mode, modeDef, productPath, modelPath, modelId, sourcePath, isFamilyMerge, secondSourcePath, familyActive, familyPreset, models])

  // CS7 — mask editor confirmed: upload the mask (server validates dims +
  // coverage + gives the real cost estimate), then queue the FLUX Fill job.
  const handleMaskRun = async (r: MaskEditorResult) => {
    if (!sourcePath) return
    setMaskRunning(true)
    try {
      const uploaded = await uploadFillMask(r.maskBlob, sourcePath)
      const result = await runStudioJob({
        mode: 'edit',
        sourceImagePath: sourcePath,
        maskPath: uploaded.maskPath,
        maskPreset: r.preset,
        prompt: r.detail,
        baseWidth: uploaded.width,
        baseHeight: uploaded.height,
      })
      toast.success(`${result.message} · আনুমানিক $${uploaded.estimatedCostUsd.toFixed(2)}`)
      setMaskEditorOpen(false)
      onOpenGallery()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setMaskRunning(false)
    }
  }

  const handleRun = async () => {
    if (!canRun) {
      toast.error('Required images missing')
      return
    }
    setRunning(true)
    try {
      const isVtonMode = mode === 'product_to_model' || mode === 'try_on'
      const result = await runStudioJob({
        mode,
        // the engine picker is authoritative for every VTON mode (single +
        // family); the legacy provider field drives swap/face/edit only
        provider: isVtonMode ? (vtonEngine === 'gemini' ? 'gemini' : 'fashn') : provider,
        vtonEngine: isVtonMode && vtonEngine !== 'gemini'
          ? (isMultiPersonFamily && vtonEngine === 'fal_idm_vton' ? 'fal_fashn_v16' : vtonEngine)
          : undefined,
        clothType: isSingleTryOn && clothType !== 'auto' ? clothType : undefined,
        protectedComposite: isMultiPersonFamily ? protectedComposite : undefined,
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
              'flex-1 py-2.5 text-[12px]',
              tab === t ? 'st-chip-on' : 'st-chip',
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
          models={models}
          onPickModel={(id) => void pickAutoModel(id)}
          familyAvailable={familyAvailable}
          includeFamily={includeFamily}
          setIncludeFamily={setIncludeFamily}
          includeReel={includeReel}
          setIncludeReel={setIncludeReel}
          defaultEngineLabel={ENGINE_LABELS_BN[config?.singleVtonDefault ?? 'fashn'] ?? 'FASHN Pro'}
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
          {!isFamilyMerge && !familyActive && (modeDef.needsModel || mode === 'product_to_model') && (
            <ModelSlot
              models={models}
              selectedId={modelId}
              uploadPreview={modelPreview}
              required={modeDef.needsModel}
              onPickSaved={(id) => {
                setModelId(id)
                setModelPreview((p) => { if (p) URL.revokeObjectURL(p); return null })
                setModelPath(null)
              }}
              onUpload={(f) => {
                setModelId('')
                void upload(f, 'model').catch((e) => toast.error(String(e)))
              }}
              onClear={() => {
                setModelId('')
                setModelPreview((p) => { if (p) URL.revokeObjectURL(p); return null })
                setModelPath(null)
              }}
            />
          )}
          {familyActive && (
            <FamilyRoleChecklist
              preset={familyPreset}
              models={models}
              onAddRole={(r) => setAddRoleSheet(r)}
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
          {/* CS7 — masked precision edit (FLUX Fill): Edit mode + uploaded source */}
          {mode === 'edit' && sourcePath && sourcePreview && engineSelectable('fal_flux_fill') && (
            <button
              type="button"
              onClick={() => setMaskEditorOpen(true)}
              className="mx-auto flex items-center gap-2 rounded-2xl border border-[#E07A5F]/40 bg-[#E07A5F]/10 px-4 py-2.5 text-[12.5px] font-bold text-[#E07A5F]"
            >
              🎯 Precision Edit — মাস্ক এঁকে শুধু সেই জায়গা বদলান (FLUX Fill)
            </button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {addRoleSheet && (
          <AddModelSheet
            lockedRole={addRoleSheet}
            onClose={() => setAddRoleSheet(null)}
            onSaved={() => void reloadModels()}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {maskEditorOpen && sourcePreview && sourcePath && (
          <MaskEditor
            imageUrl={sourcePreview}
            running={maskRunning}
            onCancel={() => setMaskEditorOpen(false)}
            onRun={(r) => void handleMaskRun(r)}
          />
        )}
      </AnimatePresence>

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
                  {isSingleTryOn ? (
                    // CS6 — single Try-On: owner picks the exact VTON engine.
                    <select
                      value={vtonEngine}
                      onChange={(e) => setVtonEngine(e.target.value as StudioEngineId)}
                      className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                    >
                      <option value="fashn" disabled={!config?.fashnConfigured}>
                        FASHN Pro (direct)
                      </option>
                      <option value="fal_fashn_v16" disabled={!engineSelectable('fal_fashn_v16')}>
                        Fal FASHN v1.6 · কমার্শিয়াল{engineSelectable('fal_fashn_v16') ? '' : ' — বন্ধ'}
                      </option>
                      <option value="fal_idm_vton" disabled={!engineSelectable('fal_idm_vton')}>
                        IDM-VTON ⚠ পরীক্ষামূলক{engineSelectable('fal_idm_vton') ? '' : ' — বন্ধ'}
                      </option>
                      <option value="gemini">Draft (Gemini)</option>
                    </select>
                  ) : mode === 'product_to_model' || mode === 'try_on' ? (
                    // Every VTON mode shows the REAL engine list (owner
                    // 2026-07-18: the old Pro/Draft dropdown hid the Fal
                    // engines). Family chains support FASHN-direct + Fal only.
                    <select
                      value={vtonEngine === 'fal_idm_vton' && isMultiPersonFamily ? 'fal_fashn_v16' : vtonEngine}
                      onChange={(e) => setVtonEngine(e.target.value as StudioEngineId)}
                      className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                    >
                      <option value="fal_fashn_v16" disabled={!engineSelectable('fal_fashn_v16')}>
                        Fal FASHN v1.6 · কমার্শিয়াল{engineSelectable('fal_fashn_v16') ? '' : ' — বন্ধ'}
                      </option>
                      <option value="fashn" disabled={!config?.fashnConfigured}>
                        FASHN Pro (direct)
                      </option>
                      {!isMultiPersonFamily && (
                        <option value="gemini">Draft (Gemini)</option>
                      )}
                    </select>
                  ) : (
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
                  )}
                  {/* CS6 — garment placement override for the Fal VTON engines */}
                  {isSingleTryOn && (vtonEngine === 'fal_idm_vton' || vtonEngine === 'fal_fashn_v16') && (
                    <select
                      value={clothType}
                      onChange={(e) => setClothType(e.target.value as typeof clothType)}
                      className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                    >
                      <option value="auto">গার্মেন্ট: Auto</option>
                      <option value="overall">পাঞ্জাবি/ফুল সেট (overall)</option>
                      <option value="upper">শুধু টপ (upper)</option>
                      <option value="lower">শুধু পাজামা (lower)</option>
                      <option value="outer">কটি/ওয়েস্টকোট (outer)</option>
                    </select>
                  )}
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

            {/* CS9 — protected composite opt-in for multi-person family runs */}
            {isMultiPersonFamily && (
              <label className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border bg-card/60 px-3 py-2">
                <span className="text-[11px] leading-snug text-muted">
                  🛡 প্রোটেক্টেড কম্পোজিট <span className="rounded bg-[#81B29A]/15 px-1 py-px text-[9px] font-bold text-[#2d6a4f]">নতুন</span>
                  <br />
                  <span className="text-[10px]">অনুমোদিত মুখ/গার্মেন্ট আর রিজেনারেট হয় না — কাটআউট বসিয়ে শুধু কিনারা+ছায়া মেলানো হয়</span>
                </span>
                <input
                  type="checkbox"
                  checked={protectedComposite}
                  onChange={(e) => setProtectedComposite(e.target.checked)}
                  className="h-4 w-4 shrink-0 accent-[#E07A5F]"
                />
              </label>
            )}
            {/* CS6 — research-only warning MUST be visible before Run (owner-locked) */}
            {isSingleTryOn && vtonEngine === 'fal_idm_vton' && (
              <div className="mb-2 rounded-xl border border-amber-400/50 bg-amber-50/10 px-3 py-2 text-[11px] leading-snug text-amber-700">
                ⚠ {idmWarning ?? 'পরীক্ষামূলক (research-only) ইঞ্জিন — ফলাফল নিজে যাচাই না করে পাবলিশ করবেন না।'}
              </div>
            )}
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
                // CS5: multi-person family actually runs the accuracy chain
                // (per-person FASHN try-on → Gemini merge) — label it honestly
                // instead of claiming the whole job is Gemini.
                // CS6: single Try-On names the exact engine the owner picked.
                <>Run — {isMultiPersonFamily
                  ? FAMILY_CHAIN_LABEL_BN
                  : isSingleTryOn
                    ? VTON_ENGINE_LABELS[vtonEngine] ?? vtonEngine
                    : effectiveProvider === 'fashn' ? 'FASHN Pro' : 'Gemini'}</>
              )}
            </motion.button>
            <p className="mt-1.5 text-center text-[10px] text-muted">
              {isMultiPersonFamily
                ? 'ফ্যামিলি ছবি: প্রতি জনের FASHN try-on, তারপর Gemini দিয়ে এক ফ্রেমে merge'
                : isSingleTryOn
                  ? pipelineMode === 'production'
                    ? 'প্রোডাকশন মোড — কড়া QC (প্রতিটা ≥৪/৫), সর্বোচ্চ ৩টি পেইড রান'
                    : 'প্রিভিউ মোড — ১টি সাশ্রয়ী রান, অটো-রিপেয়ার নেই (সেটিংসে বদলান)'
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
  models,
  onPickModel,
  familyAvailable,
  includeFamily,
  setIncludeFamily,
  includeReel,
  setIncludeReel,
  defaultEngineLabel,
  running,
  canRun,
  onRun,
}: {
  productPreview: string | null
  onProduct: (f: File) => void
  defaultModel: StudioModel | null
  models: StudioModel[]
  onPickModel: (id: string) => void
  familyAvailable: boolean
  includeFamily: boolean
  setIncludeFamily: (v: boolean) => void
  includeReel: boolean
  setIncludeReel: (v: boolean) => void
  defaultEngineLabel: string
  running: boolean
  canRun: boolean
  onRun: () => void
}) {
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-4">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <div className="text-center">
          <p className="text-[19px] font-extrabold tracking-tight text-cream">Product দিন — বাকিটা AI করবে</p>
          <p className="mt-1.5 text-[12.5px] leading-snug text-muted-hi">
            শুধু পণ্যের ছবি upload করুন। সেভ করা মডেল, prompt, ব্যাকগ্রাউন্ড — সব AI নিজেই ঠিক রাখবে।
          </p>
        </div>

        <UploadTile
          label="Product ছবি"
          preview={productPreview}
          onFile={onProduct}
          required
        />

        {/* Model — tappable: choose which saved model Auto should use (sets default) */}
        {defaultModel ? (
          <button
            type="button"
            onClick={() => setModelSheetOpen(true)}
            className="flex items-center gap-3 rounded-2xl border border-border-subtle bg-card/70 px-3.5 py-3 text-left transition-colors hover:border-[#E07A5F]/30"
          >
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-[#E07A5F]/12 text-[#E07A5F]">
              {defaultModel.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={defaultModel.imageUrl} alt={defaultModel.name} className="h-full w-full object-cover" />
              ) : (
                <UserSvg className="h-5 w-5" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-cream">মডেল: {defaultModel.name}</p>
              <p className="text-[10px] text-muted">
                {`🟢 ${defaultEngineLabel} — ডিফল্ট ইঞ্জিন চালু`}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-[#E07A5F]/12 px-2.5 py-1 text-[11px] font-semibold text-[#E07A5F]">বদলান</span>
          </button>
        ) : (
          <div className="rounded-2xl border border-amber-400/40 bg-amber-50/10 px-3.5 py-3 text-[12px] text-amber-700">
            ⚠ এখনো কোনো মডেল সেভ করা নেই। নিচের <b>লাইব্রেরি</b> ট্যাবে গিয়ে একটি মডেলের ছবি সেভ করুন — তারপর শুধু product দিলেই হবে।
          </div>
        )}

        <AnimatePresence>
          {modelSheetOpen && (
            <ModelChooserSheet
              title="Auto কোন মডেল ব্যবহার করবে"
              models={models}
              selectedId={defaultModel?.id ?? ''}
              onClose={() => setModelSheetOpen(false)}
              onPickSaved={onPickModel}
              uploadHint="নতুন ছবি আপলোড করতে চাইলে Advanced ট্যাব ব্যবহার করুন।"
            />
          )}
        </AnimatePresence>

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
            canRun && !running ? 'st-btn' : 'bg-[#94A3B8]/70',
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
          ইঞ্জিন: {defaultEngineLabel} · সাপ্লায়ার ছবির প্লেট/টেক্সট অটো-ক্লিন{includeReel ? ' · রিলে আলাদা ভিডিও খরচ' : ''}
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
          <p className="text-[15px] font-bold text-cream">
            {label}
            {required && <span className="text-[#E07A5F]"> *</span>}
          </p>
          <p className="mt-1 text-[11px] text-muted">ট্যাপ করে ছবি দিন — বাকিটা সিস্টেম করবে</p>
        </div>
      )}
    </div>
  )
}

const isPendingStatus = (s: string) => s === 'approved' || s === 'pending' || s === 'processing'
const isFailedStatus = (s: string) => s === 'failed' || s === 'error' || s === 'rejected'

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']
const toBanglaDigits = (n: number) => String(n).split('').map((c) => (c >= '0' && c <= '9' ? BN_DIGITS[+c] : c)).join('')

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
      <div className="absolute inset-x-0 h-[2px] bg-[#E07A5F]/70 shadow-[0_0_10px_2px_rgba(224,122,95,0.5)] transition-[bottom] duration-200 ease-out" style={{ bottom: `${pct}%` }} />
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
  // CS8 — masked rescue: owner paints the fix area on a flagged artifact and
  // FLUX Fill repairs ONLY that region (never auto face/embroidery repaint).
  const [rescueItem, setRescueItem] = useState<GalleryItem | null>(null)
  const [rescueRunning, setRescueRunning] = useState(false)
  const handleRescueRun = useCallback(async (r: MaskEditorResult) => {
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
  }, [rescueItem])
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
            {pendingCount}টি ছবি/ভিডিও তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে বস
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
                        initial={{ clipPath: 'inset(100% 0% 0% 0%)', opacity: 0.4 }}
                        animate={{ clipPath: 'inset(0% 0% 0% 0%)', opacity: 1 }}
                        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
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
                            ব্যর্থ{item.error ? ` · ${item.error.slice(0, 40)}` : ''}
                          </span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation()
                              void retryStudioJob(item.id)
                                .then(() => { toast.success('আবার চালানো হচ্ছে, বস'); void load() })
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
                    {item.engine === 'fal_idm_vton' ? 'IDM ⚠' : item.engine === 'fal_fashn_v16' ? 'FAL FASHN' : item.engine === 'fal_flux_fill' ? 'FLUX FILL' : item.provider === 'family_composite' ? '🛡 COMPOSITE' : item.provider}
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

            {/* CS6 — truthful engine lineage (fal VTON runs): engine, request id,
                seed, latency, actual cost + research-only badge */}
            {selected.engine && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] flex max-w-[70vw] flex-wrap items-center gap-1.5"
              >
                <span className="rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-bold text-white ring-1 ring-white/25">
                  {selected.engine === 'fal_idm_vton' ? 'IDM-VTON' : selected.engine === 'fal_fashn_v16' ? 'Fal FASHN v1.6' : selected.engine === 'fal_flux_fill' ? 'FLUX Fill' : selected.engine}
                </span>
                {selected.researchOnly && (
                  <span className="rounded-full bg-amber-500/90 px-2.5 py-1 text-[10px] font-bold text-white">
                    ⚠ পরীক্ষামূলক
                  </span>
                )}
                {typeof selected.seed === 'number' && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/85">seed {selected.seed}</span>
                )}
                {typeof selected.latencyMs === 'number' && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/85">{Math.round(selected.latencyMs / 100) / 10}s</span>
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
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] max-w-[70vw]"
              >
                <span className="rounded-lg bg-black/50 px-2.5 py-1 text-[10px] leading-snug text-white/85">
                  {selected.qcDetailsBn}
                </span>
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
                        toast.success('টেমপ্লেট বসে গেছে — "টেমপ্লেট সহ" ভার্সন দেখুন, বস')
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
        layout: isLifestyle ? layout ?? undefined : undefined,
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
  const [models, setModels] = useState<StudioModel[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // Draft = the add-model sheet: opens once a photo is picked, collects name + role.
  const [draftPreview, setDraftPreview] = useState<string | null>(null)
  const [draftPath, setDraftPath] = useState<string | null>(null)
  const [draftUploading, setDraftUploading] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('single')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const d = await fetchModels()
    setModels(d.models ?? [])
  }, [])

  useEffect(() => {
    void load().catch(() => {})
  }, [load])

  const closeDraft = useCallback(() => {
    setDraftPath(null)
    setDraftUploading(false)
    setName('')
    setRole('single')
    setDraftPreview((p) => { if (p) URL.revokeObjectURL(p); return null })
  }, [])

  const onPickFile = (f: File) => {
    setDraftPreview((p) => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(f) })
    setDraftPath(null)
    setDraftUploading(true)
    void uploadStudioFile(f, 'model-library')
      .then((p) => setDraftPath(p))
      .catch((err) => { toast.error(String(err)); closeDraft() })
      .finally(() => setDraftUploading(false))
  }

  const onSave = async () => {
    if (!name.trim() || !draftPath) {
      toast.error('নাম আর ছবি — দুটোই দরকার')
      return
    }
    setSaving(true)
    try {
      await saveModel({
        id: name.trim().toLowerCase().replace(/\s+/g, '-'),
        name: name.trim(),
        imagePath: draftPath,
        role,
      })
      toast.success(`মডেল "${name}" সেভ হলো`)
      closeDraft()
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const makeDefault = async (id: string) => {
    setBusyId(id)
    try {
      await setDefaultModel(id)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusyId(null)
    }
  }

  const removeModel = async (id: string) => {
    setBusyId(id)
    try {
      await deleteModel(id)
      setConfirmId(null)
      toast.success('মডেল মুছে ফেলা হলো')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusyId(null)
    }
  }

  const draftOpen = Boolean(draftPreview)

  return (
    <div className="mx-auto max-w-3xl px-4 pt-4 pb-10">
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPickFile(f)
          e.target.value = ''
        }}
      />

      {/* Header */}
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold tracking-tight text-cream">মডেল লাইব্রেরি</h2>
          <p className="mt-0.5 text-[11.5px] leading-snug text-muted">
            আপনার সেভ করা মডেলগুলো — try-on ও product শুটে এদের ছবি ব্যবহার হবে।
          </p>
        </div>
        {models.length > 0 && (
          <span className="shrink-0 rounded-full border border-border-subtle bg-card/70 px-2.5 py-1 text-[11px] font-semibold text-muted">
            {models.length}টি
          </span>
        )}
      </div>

      {/* Gallery grid: add-tile first, then every saved model as a portrait card */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
        <button
          type="button"
          onClick={() => ref.current?.click()}
          className="group flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#E07A5F]/35 bg-[#E07A5F]/[0.05] text-[#E07A5F] transition-colors hover:bg-[#E07A5F]/[0.09]"
        >
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[#E07A5F]/12 text-2xl leading-none transition-transform group-active:scale-95">+</span>
          <span className="text-[12px] font-semibold">নতুন মডেল</span>
          <span className="px-3 text-center text-[9.5px] leading-snug text-[#E07A5F]/60">ফুল-বডি ছবি যোগ করুন</span>
        </button>

        {models.map((m) => {
          const busy = busyId === m.id
          const confirming = confirmId === m.id
          return (
            <div
              key={m.id}
              className="group relative aspect-[3/4] overflow-hidden rounded-2xl border border-border-subtle bg-bg-1 shadow-sm"
            >
              {m.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.imageUrl} alt={m.name} loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <span className="grid h-full w-full place-items-center text-muted">
                  <UserSvg className="h-8 w-8" />
                </span>
              )}

              {/* bottom gradient + name / role */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-2.5 pb-2 pt-8">
                <p className="truncate text-[13px] font-bold text-white">{m.name}</p>
                <p className="truncate text-[10px] text-white/70">{roleLabelBn(m.role)}</p>
              </div>

              {/* default badge */}
              {m.isDefault && (
                <span className="absolute left-2 top-2 rounded-full bg-[#E07A5F] px-2 py-0.5 text-[9px] font-bold text-white shadow-sm">
                  ⭐ ডিফল্ট
                </span>
              )}

              {/* action buttons (top-right) */}
              <div className="absolute right-1.5 top-1.5 flex gap-1">
                {!m.isDefault && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void makeDefault(m.id)}
                    title="ডিফল্ট করুন"
                    className="grid h-7 w-7 place-items-center rounded-full bg-black/45 text-[13px] text-white backdrop-blur-sm transition-colors hover:bg-black/65 disabled:opacity-50"
                  >
                    ☆
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmId(m.id)}
                  title="মুছুন"
                  className="grid h-7 w-7 place-items-center rounded-full bg-black/45 text-[12px] text-white backdrop-blur-sm transition-colors hover:bg-red-500/80 disabled:opacity-50"
                >
                  🗑
                </button>
              </div>

              {/* delete confirm overlay */}
              {confirming && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 px-3 text-center backdrop-blur-sm">
                  <p className="text-[12px] font-semibold text-white">মুছে ফেলবেন?</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removeModel(m.id)}
                      className="rounded-full bg-red-500 px-3.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
                    >
                      {busy ? '…' : 'হ্যাঁ, মুছুন'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className="rounded-full bg-white/15 px-3.5 py-1.5 text-[11px] font-semibold text-white"
                    >
                      না
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {models.length === 0 && (
        <p className="mt-4 text-center text-[11.5px] text-muted">
          এখনো কোনো মডেল নেই। উপরের <b className="text-[#E07A5F]">নতুন মডেল</b> কার্ডে ট্যাপ করে শুরু করুন।
        </p>
      )}

      <ModelCreatorCard models={models} onQueued={() => void load()} />
      <StudioSettingsCard />

      {/* Add-model sheet */}
      <AnimatePresence>
        {draftOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !saving && closeDraft()}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          >
            <motion.div
              initial={{ y: 40, opacity: 0.6 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-t-3xl border border-border-subtle bg-card p-4 shadow-2xl sm:rounded-3xl"
              style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-cream">নতুন মডেল যোগ করুন</h3>
                <button type="button" onClick={() => !saving && closeDraft()} className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted">✕</button>
              </div>

              <div className="flex gap-3">
                <div className="relative h-40 w-32 shrink-0 overflow-hidden rounded-xl bg-bg-1">
                  {draftPreview && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={draftPreview} alt="preview" className="h-full w-full object-cover" />
                  )}
                  {draftUploading && (
                    <div className="absolute inset-0 grid place-items-center bg-black/40">
                      <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => ref.current?.click()}
                    className="absolute inset-x-0 bottom-0 bg-black/55 py-1 text-center text-[10px] font-semibold text-white backdrop-blur-sm"
                  >
                    ছবি বদলান
                  </button>
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <div>
                    <label className="mb-1 block text-[10.5px] font-semibold text-muted">নাম</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="যেমন: Maruf"
                      className="w-full rounded-xl border border-border bg-bg-1 px-3 py-2.5 text-[13px] text-cream outline-none focus:border-[#E07A5F]/50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10.5px] font-semibold text-muted">ধরন</label>
                    <div className="flex flex-wrap gap-1.5">
                      {MODEL_ROLES.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setRole(r.id)}
                          className={cn(
                            'rounded-full px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                            role === r.id ? 'bg-[#E07A5F] text-white' : 'border border-border bg-bg-1 text-muted',
                          )}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <button
                type="button"
                disabled={saving || draftUploading || !draftPath || !name.trim()}
                onClick={() => void onSave()}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[#E07A5F] py-3 text-[14px] font-bold text-white transition-opacity disabled:opacity-40"
              >
                {saving ? (
                  <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> সেভ হচ্ছে…</>
                ) : draftUploading ? 'ছবি আপলোড হচ্ছে…' : 'সেভ করুন'}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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
    <div className="mt-4 st-card p-3">
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
  const [config, setConfig] = useState<StudioConfig | null>(null)
  // CS10 — golden evaluation summary + run trigger
  const [goldenEval, setGoldenEval] = useState<GoldenEvalSummary | null>(null)
  const [evalRunning, setEvalRunning] = useState(false)
  // CS12 — engine health + kill switches
  const [health, setHealth] = useState<StudioHealth | null>(null)
  useEffect(() => {
    void fetchStudioSettings().then(setSettings).catch(() => {})
    void fetchStudioConfig().then(setConfig).catch(() => {})
    void fetchGoldenEval().then(setGoldenEval).catch(() => {})
    void fetchStudioHealth().then(setHealth).catch(() => {})
  }, [])
  if (!settings) return null

  const saveFalFlag = (patch: Partial<Pick<StudioSettings, 'falEnabled' | 'idmVtonEnabled' | 'fluxFillEnabled'>> & { singleVtonDefault?: StudioEngineId }) => {
    setSettings({ ...settings, ...patch })
    void saveStudioSettings(patch).then(() => toast.success('সেভ হয়েছে')).catch(() => toast.error('হয়নি'))
  }
  return (
    <div className="mt-3 space-y-2.5 st-card p-3">
      <p className="text-[12px] font-bold text-cream">⚙️ স্টুডিও সেটিংস</p>
      {/* CS8 — Preview vs Production: bounded spend shown up front */}
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">পাইপলাইন মোড</span>
        <select
          value={settings.pipelineMode}
          onChange={(e) => {
            const pipelineMode = e.target.value as StudioSettings['pipelineMode']
            setSettings({ ...settings, pipelineMode })
            void saveStudioSettings({ pipelineMode }).then(() => toast.success('সেভ হয়েছে — পরের রান থেকে কার্যকর')).catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="preview">প্রিভিউ — ১টি সাশ্রয়ী রান</option>
          <option value="production">প্রোডাকশন — কড়া QC · সর্বোচ্চ ৩ পেইড রান</option>
        </select>
      </label>
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
        <span className="text-[11px] text-muted">ইমেজ ইঞ্জিন</span>
        <select
          value={settings.imageEngine}
          onChange={(e) => {
            const imageEngine = e.target.value as StudioSettings['imageEngine']
            setSettings({ ...settings, imageEngine })
            void saveStudioSettings({ imageEngine }).then(() => toast.success('সেভ হয়েছে — পরের রেন্ডার থেকে কার্যকর')).catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="gemini">Nano Banana (ফটোরিয়াল · মুখ/মডেল সেরা)</option>
          <option value="gpt">GPT Image 2 (লেখা/পোস্টার সেরা · দ্রুত)</option>
          <option value="seedream">Seedream 5.0 Pro (2K ডিটেইল · নতুন)</option>
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

      {/* CS5 — Fal engine foundation: owner flags only. Engines become runnable
          in CS6 (try-on) / CS7 (FLUX Fill); flipping these today changes nothing
          in the Run tab, so the current defaults stay exactly as they were. */}
      <div className="border-t border-border-subtle pt-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-bold text-cream">🧪 Fal ইঞ্জিন (নতুন — সামনের ফেজে চালু)</p>
          {config && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[9px] font-semibold',
                config.falConfigured ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-amber-100 text-amber-800',
              )}
            >
              {config.falConfigured ? 'FAL_KEY আছে' : 'FAL_KEY নেই'}
            </span>
          )}
        </div>
        <p className="mb-2 mt-0.5 text-[10px] text-muted">
          এখন শুধু প্রস্তুতি — Try-On ইঞ্জিন বাছাই (CS6) ও মাস্ক-এডিট (CS7) এলে এগুলো কাজে লাগবে। আজকের রেন্ডার আগের মতোই চলবে।
        </p>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">Fal ইঞ্জিন চালু (FASHN v1.6 · কমার্শিয়াল)</span>
          <input
            type="checkbox"
            checked={settings.falEnabled}
            onChange={(e) => saveFalFlag({ falEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">
            IDM-VTON <span className="rounded bg-amber-100 px-1 py-px text-[9px] font-bold text-amber-800">পরীক্ষামূলক · research-only</span>
          </span>
          <input
            type="checkbox"
            checked={settings.idmVtonEnabled}
            onChange={(e) => saveFalFlag({ idmVtonEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">FLUX Fill (মাস্ক-করা জায়গা এডিট)</span>
          <input
            type="checkbox"
            checked={settings.fluxFillEnabled}
            onChange={(e) => saveFalFlag({ fluxFillEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">ডিফল্ট ইঞ্জিন — সব রানে (সিঙ্গেল + ফ্যামিলি)</span>
          <select
            value={settings.singleVtonDefault}
            onChange={(e) => saveFalFlag({ singleVtonDefault: e.target.value as StudioEngineId })}
            className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
          >
            <option value="fal_fashn_v16">Fal FASHN v1.6 · কমার্শিয়াল</option>
            <option value="fashn">FASHN Pro (direct)</option>
            <option value="fal_idm_vton">IDM-VTON (পরীক্ষামূলক · শুধু সিঙ্গেল)</option>
          </select>
        </label>
      </div>
      {/* CS12 — engine health, kill switches, worker heartbeat, balances */}
      {health && (
        <div className="border-t border-border-subtle pt-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-bold text-cream">🚦 ইঞ্জিন হেলথ (শেষ {health.windowDays} দিন)</p>
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold', health.worker.healthy ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-red-100 text-red-700')}>
              Worker {health.worker.healthy ? 'সচল' : 'সাড়া নেই'}
            </span>
          </div>
          <div className="mt-1.5 space-y-1">
            {health.engines.slice(0, 6).map((e) => (
              <div key={e.engine} className="flex items-center justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-[10px] leading-snug text-muted-hi">
                  {e.labelBn}: {e.jobs} কাজ · ব্যর্থ {e.errorRatePct}%{e.qcPassRatePct !== null ? ` · QC পাস ${e.qcPassRatePct}%` : ''}{e.p95LatencyMs ? ` · p95 ${Math.round(e.p95LatencyMs / 1000)}s` : ''} · ${e.spendUsd}
                </p>
                <label className="flex shrink-0 items-center gap-1 text-[9px] text-muted">
                  বন্ধ
                  <input
                    type="checkbox"
                    checked={Boolean(health.kills[e.engine])}
                    onChange={(ev) => {
                      const killed = ev.target.checked
                      setHealth({ ...health, kills: { ...health.kills, [e.engine]: killed } })
                      void setEngineKill(e.engine, killed)
                        .then(() => toast.success(killed ? e.labelBn + ' বন্ধ (kill switch)' : e.labelBn + ' চালু'))
                        .catch(() => toast.error('হয়নি'))
                    }}
                    className="h-3.5 w-3.5 accent-red-500"
                  />
                </label>
              </div>
            ))}
          </div>
          {health.balances.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted">
              ব্যালেন্স: {health.balances.map((b) => b.label + ' ' + (b.balanceUsd !== null ? '$' + b.balanceUsd : '—')).join(' · ')}
            </p>
          )}
        </div>
      )}

      {/* CS10 — golden evaluation: measurable engine comparison, owner-triggered */}
      <div className="border-t border-border-subtle pt-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-bold text-cream">🏅 গোল্ডেন টেস্ট (ইঞ্জিন তুলনা)</p>
          <button
            type="button"
            disabled={evalRunning || !goldenEval?.cases?.length}
            onClick={() => {
              setEvalRunning(true)
              void runGoldenEvalNow()
                .then((r) => toast.success(`টেস্ট চলছে (${r.runId}) — আনুমানিক $${r.estimatedCostUsd} · কিছুক্ষণ পরে এখানে ফল আসবে`))
                .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
                .finally(() => setEvalRunning(false))
            }}
            className="rounded-full bg-[#E07A5F] px-3 py-1 text-[10px] font-bold text-white disabled:opacity-40"
          >
            {evalRunning ? 'পাঠানো হচ্ছে…' : 'টেস্ট চালাও'}
          </button>
        </div>
        <p className="mt-0.5 text-[10px] text-muted">
          {goldenEval?.cases?.length
            ? `${goldenEval.cases.length}টি গোল্ডেন কেস — ৩ ইঞ্জিনে একই ছবি চালিয়ে সংখ্যায় তুলনা`
            : 'গোল্ডেন কেস এখনো নেই — evaluations API দিয়ে case যোগ করুন'}
        </p>
        {goldenEval?.comparison && (
          <div className="mt-1.5 space-y-1">
            {goldenEval.comparison.rankings.map((r) => (
              <p key={r.engine} className="text-[10px] leading-snug text-muted-hi">{r.reasonBn}</p>
            ))}
            <p className="text-[10.5px] font-semibold text-cream">{goldenEval.comparison.verdictBn}</p>
          </div>
        )}
      </div>

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
      toast.success('লোগো সেভ হয়েছে বস ✅ — পরের ফিনিশিং-এ এটাই বসবে।')
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
          ⚠️ এখনো কোনো লোগো আপলোড করা হয়নি, বস। লোগো ছাড়া ফিনিশিং করলে ছবিতে শুধু লেখা আর রং বসবে, লোগো বসবে না। নিচে একবার আপনার লোগো আপলোড করে নিন — এরপর প্রতিটা ফিনিশিং-এ এটাই বসবে।
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
function VideoStudioView({ onOpenGallery, onOpenStudio }: { onOpenGallery: () => void; onOpenStudio: () => void }) {
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
              <span className="block text-[10px] text-muted">স্টুডিওর Auto মোডে "🎬 ছোট রিলও বানাও" টগল অন করুন</span>
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
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', selected?.id === up.id ? 'st-chip-on' : 'st-chip')}>
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
                    className={cn(
                      'rounded-lg px-3.5 py-1.5 text-[12px] font-semibold',
                      targets.includes(t) ? 'st-chip-on' : 'st-chip',
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
                      aspect === a.id ? 'st-chip-on' : 'st-chip',
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
                        audioMode === m.id ? 'st-chip-on' : 'st-chip',
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
            className="st-btn w-full py-2.5 text-[13px]"
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
      toast.success('ট্র্যাক যোগ হয়েছে, বস')
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
              vibe === v.id ? 'st-chip-on' : 'st-chip',
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
      .then((r) => toast.success(`${label} তৈরি হচ্ছে (~৳${r.costBdt}) — Gallery-তে আসবে, বস`))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
      .finally(() => setBusy(null))
  }, [])

  const card = 'space-y-2 st-card p-3'
  const input = 'w-full rounded-lg border border-border-subtle bg-bg-1 px-2.5 py-2 text-[12px] text-cream placeholder:text-muted/50'
  const btn = 'st-btn px-4 py-2 text-[12px]'

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
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', musicStyle === st.id ? 'st-chip-on' : 'st-chip')}>
                {st.labelBn}
              </button>
            ))}
          </div>
          <input value={musicLine} onChange={(e) => setMusicLine(e.target.value)} placeholder="মুড/থিম এক লাইনে (ঐচ্ছিক)" className={input} />
          <div className="flex items-center gap-2">
            {[30, 60].map((s2) => (
              <button key={s2} type="button" onClick={() => setMusicSec(s2)}
                className={cn('rounded-lg px-3 py-1.5 text-[11px] font-semibold', musicSec === s2 ? 'st-chip-on' : 'st-chip')}>
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
                className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold', occasion === o.id ? 'st-chip-on' : 'st-chip')}>
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

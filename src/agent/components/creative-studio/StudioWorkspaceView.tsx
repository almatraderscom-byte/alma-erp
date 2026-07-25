'use client'

import MaskEditor, { type MaskEditorResult } from '@/agent/components/creative-studio/MaskEditor'
import {
  fetchModels,
  fetchStudioSettings,
  runAutoStudioJob,
  runStudioJob,
  saveModel,
  setDefaultModel,
  uploadFillMask,
  uploadStudioFile,
  type StudioConfig,
} from '@/agent/components/creative-studio/studio-api'
import {
  ASPECT_RATIOS,
  BACKGROUND_PRESETS,
  FAMILY_PRESETS,
  GEN_MODES,
  RESOLUTIONS,
  STUDIO_MODES,
  VIDEO_VIBES,
  type FamilyPresetId,
  type StudioModeId,
  type StudioProvider,
} from '@/lib/creative-studio/constants'
import { FAMILY_CHAIN_LABEL_BN, type StudioEngineId } from '@/lib/creative-studio/provider-registry'
import { getAdvancedModeCapability } from '@/lib/creative-studio/advanced-image-capabilities'
import { XAI_TEMPLATES, type XaiTemplate } from '@/lib/creative-studio/xai-imagine'
import type { FashnGenerationMode, FashnResolution } from '@/lib/fashn/types'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'

import { UserSvg } from '@/agent/components/creative-studio/StudioUi'
import { CampaignPackPanel } from '@/agent/components/creative-studio/CampaignPackPanel'

export type StudioModel = {
  id: string
  name: string
  role: string | null
  isDefault: boolean
  imagePath?: string
  imageUrl?: string | null
  /** CS14 — avatar status (multi-angle identity) */
  avatar?: { built: boolean; building: boolean; count: number } | null
}

/** Bangla label for a model role (falls back to the raw role for anything odd). */
export function roleLabelBn(role: string | null): string {
  switch (role) {
    case 'single':
      return 'একক / নিজে'
    case 'father':
      return 'বাবা'
    case 'mother':
      return 'মা'
    case 'son':
      return 'ছেলে'
    case 'daughter':
      return 'মেয়ে'
    default:
      return role ?? ''
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
              if (f) {
                onUpload(f)
                onClose()
              }
              e.target.value = ''
            }}
          />
        )}

        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-cream">{title}</h3>
          <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted">
            ✕
          </button>
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
                    onClick={() => {
                      onPickSaved(m.id)
                      onClose()
                    }}
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
                      <span className="grid h-full w-full place-items-center bg-bg-1 text-muted">
                        <UserSvg className="h-6 w-6" />
                      </span>
                    )}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4">
                      <span className="block truncate text-left text-[10px] font-bold text-white">{m.name}</span>
                    </div>
                    {active && (
                      <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[#E07A5F] text-[10px] text-white shadow">
                        ✓
                      </span>
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
            লাইব্রেরিতে কোনো সেভ করা মডেল নেই। {onUpload ? 'এখন একটা ছবি আপলোড করতে পারেন, অথবা ' : ''}
            <b className="text-cream">লাইব্রেরি</b> ট্যাবে গিয়ে মডেল সেভ করুন।
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
            onClick={() => {
              onClear()
              onClose()
            }}
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
              <p className="text-[14px] font-bold text-cream">Model{required && <span className="text-[#E07A5F]"> *</span>}</p>
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

export const MODEL_ROLES = [
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
function AddModelSheet({ lockedRole, onClose, onSaved }: { lockedRole?: string; onClose: () => void; onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState(lockedRole ?? 'single')
  const [saving, setSaving] = useState(false)

  const onPick = (f: File) => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return URL.createObjectURL(f)
    })
    setPath(null)
    setUploading(true)
    void uploadStudioFile(f, 'model-library')
      .then((p) => setPath(p))
      .catch((err) => toast.error(String(err)))
      .finally(() => setUploading(false))
  }

  const save = async () => {
    if (!name.trim() || !path) {
      toast.error('নাম আর ছবি — দুটোই দরকার')
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
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onPick(f)
            e.target.value = ''
          }}
        />
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-cream">{lockedLabel ? `${lockedLabel} মডেল যোগ করুন` : 'নতুন মডেল যোগ করুন'}</h3>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted"
          >
            ✕
          </button>
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
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> সেভ হচ্ছে…
            </>
          ) : uploading ? (
            'ছবি আপলোড হচ্ছে…'
          ) : (
            'সেভ করুন'
          )}
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
export const ENGINE_LABELS_BN: Record<string, string> = {
  fashn: 'FASHN Pro',
  fal_fashn_v16: 'Fal FASHN v1.6',
  fal_idm_vton: 'IDM-VTON ⚠',
  gemini: 'Gemini',
  xai_imagine: 'Grok Imagine (xAI)',
}

export function StudioWorkspaceView({ config, onOpenGallery }: { config: StudioConfig | null; onOpenGallery: () => void }) {
  const [mode, setMode] = useState<StudioModeId>('product_to_model')
  // CS13 — 'xai_imagine' joins the legacy provider choice for swap/face/edit
  const [provider, setProvider] = useState<StudioProvider | 'xai_imagine'>('fashn')
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
  const [imageEngine, setImageEngine] = useState<'gemini' | 'gpt' | 'seedream'>('gemini')
  useEffect(() => {
    void fetchStudioSettings()
      .then((s) => {
        setPipelineMode(s.pipelineMode)
        setImageEngine(s.imageEngine)
      })
      .catch(() => {})
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
  const [tab, setTab] = useState<'auto' | 'pack' | 'advanced'>('auto')
  const [includeFamily, setIncludeFamily] = useState(false)
  const [includeReel, setIncludeReel] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)

  const modeDef = useMemo(() => STUDIO_MODES.find((m) => m.id === mode)!, [mode])
  const bgPrompt = BACKGROUND_PRESETS.find((b) => b.id === backgroundId)?.prompt ?? ''

  // full_family merge mode: combine two uploaded images (baba+chele + ma+meye) into one shot.
  const isFamilyMerge = familyPreset === 'full_family' && (mode === 'product_to_model' || mode === 'try_on')

  // A role-based family preset is active (baba+chele etc., but NOT the full_family
  // merge which has its own two-upload UI). When active, the single-model slot is
  // replaced by the role checklist — members come from the library by role.
  const familyActive =
    !isFamilyMerge &&
    (mode === 'product_to_model' || mode === 'try_on') &&
    familyPreset !== 'single' &&
    Boolean(FAMILY_REQUIRED_ROLES[familyPreset])
  // which role's add-model sheet is open (from the family checklist)
  const [addRoleSheet, setAddRoleSheet] = useState<FamilyRole | null>(null)

  // Any multi-person family preset (baba+chele, ma+meye, full family) must render on
  // Gemini — FASHN tryon-max is single-person only and can't place 2+ people. The
  // backend already forces this; mirror it in the UI so the Run button / provider
  // label is honest instead of saying "FASHN Pro" while Gemini actually runs.
  const isMultiPersonFamily = familyPreset !== 'single' && (mode === 'product_to_model' || mode === 'try_on')
  const effectiveProvider: StudioProvider | 'xai_imagine' = isMultiPersonFamily && provider !== 'xai_imagine' ? 'gemini' : provider

  // CS6 — engine picker applies ONLY to single-person Try-On. IDM/Fal engines
  // are hidden everywhere else (family, swap, face, edit, video) by design.
  const isSingleTryOn = mode === 'try_on' && familyPreset === 'single'
  // CS13.3 — TRUE exactly when the backend will run Grok Imagine: single,
  // generate, 2-person pairs and the 2-image family merge. Role-based
  // full_family (4 জন > xAI's 3-reference cap) stays on the chain.
  const xaiWillRun =
    (mode === 'generate' ||
      (mode === 'product_to_model' || mode === 'try_on' ? vtonEngine === 'xai_imagine' : provider === 'xai_imagine')) &&
    !(familyPreset === 'full_family' && !isFamilyMerge && (mode === 'product_to_model' || mode === 'try_on'))
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
  const xaiUsable = engineSelectable('xai_imagine')
  // Owner default from settings; fall back to direct FASHN when it isn't selectable.
  useEffect(() => {
    if (!config) return
    const def = config.singleVtonDefault ?? 'fashn'
    setVtonEngine(def === 'fashn' || def === 'gemini' || engineSelectable(def) ? def : 'fashn')
  }, [config, engineSelectable])
  const idmWarning = engineAvail.get('fal_idm_vton')?.warningBn ?? null
  const VTON_ENGINE_LABELS = ENGINE_LABELS_BN
  const genericEngineLabel = config?.genericImageModels?.pro
    ?? (imageEngine === 'gpt' ? 'GPT Image 2' : imageEngine === 'seedream' ? 'Seedream 5 Pro' : 'Gemini 3 Image')

  // CSE-A — Fal VTON endpoints cannot serve a single Product→Model request.
  // Reset a stale Try-On selection instead of letting it silently fall through.
  useEffect(() => {
    if (
      mode === 'product_to_model'
      && familyPreset === 'single'
      && (vtonEngine === 'fal_fashn_v16' || vtonEngine === 'fal_idm_vton')
    ) {
      setVtonEngine(config?.fashnConfigured ? 'fashn' : xaiUsable ? 'xai_imagine' : 'gemini')
    }
  }, [mode, familyPreset, vtonEngine, config?.fashnConfigured, xaiUsable])

  const selectedAdvancedEngine: StudioEngineId =
    mode === 'generate'
      ? 'xai_imagine'
      : mode === 'product_to_model' || mode === 'try_on'
        ? vtonEngine
        : provider === 'xai_imagine'
          ? 'xai_imagine'
          : provider
  const fidelityCapability = getAdvancedModeCapability(selectedAdvancedEngine, mode)
  useEffect(() => {
    if (mode === 'face_to_model' && selectedAdvancedEngine === 'fashn' && aspectRatio === '16:9') {
      setAspectRatio('4:5')
    }
  }, [mode, selectedAdvancedEngine, aspectRatio])

  const defaultModel = useMemo(() => models.find((m) => m.isDefault) ?? models[0] ?? null, [models])
  const familyAvailable = useMemo(() => {
    const roles = new Set(models.map((m) => m.role))
    return (
      (roles.has('father') && roles.has('son')) ||
      (roles.has('mother') && roles.has('son')) ||
      (roles.has('mother') && roles.has('daughter'))
    )
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
  const pickAutoModel = useCallback(
    async (id: string) => {
      try {
        await setDefaultModel(id)
        await reloadModels()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed')
      }
    },
    [reloadModels],
  )

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
  // CS13 — Grok Imagine usable ⇒ generate mode works and fashn-only modes unlock
  useEffect(() => {
    if (mode === 'image_to_video') {
      setProvider('gemini')
      return
    }
    if (mode === 'generate') {
      setProvider('xai_imagine')
      return
    } // xAI is the only generate engine
    setProvider((prev) => {
      // an explicit Grok Imagine choice (picker or template) survives mode hops
      if (prev === 'xai_imagine' && xaiUsable) return prev
      if (fashnOnly) return config?.fashnConfigured ? 'fashn' : xaiUsable ? 'xai_imagine' : 'fashn'
      return config?.fashnConfigured ? 'fashn' : 'gemini'
    })
  }, [config, mode, fashnOnly, xaiUsable])

  // Switching mode invalidates the previously uploaded images (e.g. a Try-On
  // product makes no sense as a Model-Swap source). Clear previews + paths so a
  // stale upload from a different mode can't silently flow into the next Run.
  const clearUploads = useCallback(() => {
    setProductPreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return null
    })
    setModelPreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return null
    })
    setSourcePreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return null
    })
    setSecondSourcePreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return null
    })
    setProductPath(null)
    setModelPath(null)
    setSourcePath(null)
    setSecondSourcePath(null)
  }, [])

  const selectMode = useCallback(
    (next: StudioModeId) => {
      if (next === mode) return
      if (FASHN_ONLY_MODES.includes(next) && !config?.fashnConfigured && !xaiUsable) {
        toast.error('এই mode-এর জন্য FASHN Pro বা Grok Imagine দরকার — এখন configure করা নেই।')
        return
      }
      if (next === 'generate' && !xaiUsable) {
        toast.error('Generate mode-এর জন্য Grok Imagine (xAI) দরকার — সেটিংস থেকে চালু করুন।')
        return
      }
      clearUploads()
      setMode(next)
    },
    [mode, config, clearUploads, xaiUsable],
  )

  // CS13 — template presets (x.ai-console style): deterministic prefills only,
  // never auto-run. The owner still uploads references + taps Run.
  const applyTemplate = useCallback(
    (t: XaiTemplate) => {
      if (!xaiUsable) {
        toast.error('Grok Imagine চালু নেই — লাইব্রেরি → স্টুডিও সেটিংস থেকে চালু করুন।')
        return
      }
      if (t.mode !== mode) {
        clearUploads()
        setMode(t.mode)
      }
      if (t.mode === 'product_to_model' || t.mode === 'try_on') {
        setVtonEngine('xai_imagine')
        setFamilyPreset('single')
      }
      setProvider('xai_imagine')
      setPrompt(t.prompt)
      setAspectRatio(t.aspectRatio)
      setResolution(t.resolution as FashnResolution)
      setNumImages(1)
      setPanelOpen(true)
      toast.success(`টেমপ্লেট: ${t.labelBn} — ছবি দিয়ে Run চাপুন`)
    },
    [xaiUsable, mode, clearUploads],
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
    // CS13 — generate is text-to-image: a prompt is the only requirement
    if (mode === 'generate') return prompt.trim().length > 0
    if (mode === 'edit' && !prompt.trim()) return false
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
  }, [
    mode,
    modeDef,
    productPath,
    modelPath,
    modelId,
    sourcePath,
    isFamilyMerge,
    secondSourcePath,
    familyActive,
    familyPreset,
    models,
    prompt,
  ])

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
      // CS13 — Grok Imagine rides the vtonEngine field for EVERY mode: the
      // backend xai branch triggers on vtonEngine === 'xai_imagine' (and on
      // mode === 'generate') before any legacy provider resolution.
      const xaiPicked = mode === 'generate' || (isVtonMode ? vtonEngine === 'xai_imagine' : provider === 'xai_imagine')
      const result = await runStudioJob({
        mode,
        // the engine picker is authoritative for every VTON mode (single +
        // family); the legacy provider field drives swap/face/edit only
        provider: xaiPicked
          ? 'fashn' // ignored — the xai branch returns before provider resolution
          : isVtonMode
            ? vtonEngine === 'gemini'
              ? 'gemini'
              : 'fashn'
            : (provider as StudioProvider),
        vtonEngine: xaiPicked
          ? 'xai_imagine'
          : isVtonMode && vtonEngine !== 'gemini'
            ? isMultiPersonFamily && vtonEngine === 'fal_idm_vton'
              ? 'fal_fashn_v16'
              : vtonEngine
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
        {(['auto', 'pack', 'advanced'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn('flex-1 py-2.5 text-[12px]', tab === t ? 'st-chip-on' : 'st-chip')}
          >
            {t === 'auto' ? '✨ Auto' : t === 'pack' ? '📦 Campaign Pack' : '⚙ Advanced'}
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

      {tab === 'pack' && <CampaignPackPanel />}

      {tab === 'advanced' && (
        <>
          {/* Canvas / drop zone */}
          <div
            className={cn(
              'min-h-0 flex-1 overflow-y-auto px-3 pt-3',
              panelOpen ? 'pb-[min(58vh,480px)] md:pb-[min(52vh,420px)]' : 'pb-28 md:pb-20',
            )}
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-3">
              {/* CS13 — generate is text-to-image: no reference uploads at all */}
              {mode !== 'generate' && (
                <UploadTile
                  label={
                    isFamilyMerge
                      ? 'বাবা + ছেলে ছবি (১ম)'
                      : modeDef.needsProduct
                        ? 'Product / mannequin'
                        : mode === 'edit'
                          ? 'Extra reference (optional — কম্বাইন্ড লিস্টিং)'
                          : 'Product (optional)'
                  }
                  preview={productPreview}
                  onFile={(f) => void upload(f, 'product').catch((e) => toast.error(String(e)))}
                  required={modeDef.needsProduct}
                />
              )}
              {mode === 'generate' && (
                <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-6 text-center text-[12.5px] text-muted">
                  ✨ টেক্সট থেকে ছবি — নিচে প্রম্পট লিখে Run চাপুন (Grok Imagine · xAI)
                </div>
              )}
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
                    setModelPreview((p) => {
                      if (p) URL.revokeObjectURL(p)
                      return null
                    })
                    setModelPath(null)
                  }}
                  onUpload={(f) => {
                    setModelId('')
                    void upload(f, 'model').catch((e) => toast.error(String(e)))
                  }}
                  onClear={() => {
                    setModelId('')
                    setModelPreview((p) => {
                      if (p) URL.revokeObjectURL(p)
                      return null
                    })
                    setModelPath(null)
                  }}
                />
              )}
              {familyActive && <FamilyRoleChecklist preset={familyPreset} models={models} onAddRole={(r) => setAddRoleSheet(r)} />}
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
              <AddModelSheet lockedRole={addRoleSheet} onClose={() => setAddRoleSheet(null)} onSaved={() => void reloadModels()} />
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
            style={{
              paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))',
            }}
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
                {/* CS13 — Grok Imagine templates (x.ai-console style prefills) */}
                {xaiUsable && (
                  <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {XAI_TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => applyTemplate(t)}
                        title={t.hintBn}
                        className="shrink-0 rounded-full border border-[#E07A5F]/30 bg-[#E07A5F]/10 px-2.5 py-1 text-[10px] font-semibold text-cream"
                      >
                        ⚡ {t.labelBn}
                      </button>
                    ))}
                  </div>
                )}

                {/* Mode chips */}
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {STUDIO_MODES.map((m) => {
                    const locked =
                      (FASHN_ONLY_MODES.includes(m.id) && !config?.fashnConfigured && !xaiUsable) || (m.id === 'generate' && !xaiUsable)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => selectMode(m.id)}
                        disabled={locked}
                        title={locked ? (m.id === 'generate' ? 'Grok Imagine (xAI) দরকার' : 'FASHN Pro বা Grok Imagine দরকার') : undefined}
                        className={cn(
                          'shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all',
                          mode === m.id ? 'bg-gold/20 border border-gold/30 text-cream shadow-sm' : 'bg-white/[0.05] text-muted',
                          locked && 'cursor-not-allowed opacity-40',
                        )}
                      >
                        {m.short}
                        {locked ? ' 🔒' : ''}
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
                  placeholder={
                    mode === 'generate'
                      ? 'কী বানাতে চান লিখুন (আবশ্যক) — e.g. Eid campaign visual, coral palette…'
                      : 'Optional: Blonde hair, studio photoshoot, festive mood…'
                  }
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
                          {(mode === 'try_on' || isMultiPersonFamily) && (
                            <option value="fal_fashn_v16" disabled={!engineSelectable('fal_fashn_v16')}>
                              Fal FASHN v1.6 · কমার্শিয়াল
                              {engineSelectable('fal_fashn_v16') ? '' : ' — বন্ধ'}
                            </option>
                          )}
                          <option value="fal_idm_vton" disabled={!engineSelectable('fal_idm_vton')}>
                            IDM-VTON ⚠ পরীক্ষামূলক
                            {engineSelectable('fal_idm_vton') ? '' : ' — বন্ধ'}
                          </option>
                          <option value="xai_imagine" disabled={!xaiUsable}>
                            Grok Imagine (xAI){xaiUsable ? '' : ' — বন্ধ'}
                          </option>
                          <option value="gemini">Guided draft ({genericEngineLabel})</option>
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
                          {(mode === 'try_on' || isMultiPersonFamily) && (
                            <option value="fal_fashn_v16" disabled={!engineSelectable('fal_fashn_v16')}>
                              Fal FASHN v1.6 · কমার্শিয়াল
                              {engineSelectable('fal_fashn_v16') ? '' : ' — বন্ধ'}
                            </option>
                          )}
                          <option value="fashn" disabled={!config?.fashnConfigured}>
                            FASHN Pro (direct)
                          </option>
                          <option value="xai_imagine" disabled={!xaiUsable}>
                            Grok Imagine (xAI){xaiUsable ? '' : ' — বন্ধ'}
                          </option>
                          {!isMultiPersonFamily && <option value="gemini">Guided draft ({genericEngineLabel})</option>}
                        </select>
                      ) : mode === 'generate' ? (
                        // CS13 — generate has exactly one server: Grok Imagine
                        <span className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px] text-muted">
                          ইঞ্জিন: Grok Imagine (xAI)
                        </span>
                      ) : (
                        <select
                          value={provider}
                          onChange={(e) => setProvider(e.target.value as StudioProvider | 'xai_imagine')}
                          className="rounded-lg border border-border bg-card/80 px-2 py-1.5 text-[11px]"
                        >
                          <option value="fashn" disabled={!config?.fashnConfigured}>
                            Pro (FASHN)
                          </option>
                          <option value="xai_imagine" disabled={!xaiUsable}>
                            Grok Imagine (xAI){xaiUsable ? '' : ' — বন্ধ'}
                          </option>
                          <option value="gemini" disabled={fashnOnly}>
                            Guided draft ({genericEngineLabel}){fashnOnly ? ' — N/A' : ''}
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
                          <option
                            key={a}
                            value={a}
                            disabled={mode === 'face_to_model' && selectedAdvancedEngine === 'fashn' && a === '16:9'}
                          >
                            {a}
                            {mode === 'face_to_model' && selectedAdvancedEngine === 'fashn' && a === '16:9'
                              ? ' — N/A'
                              : ''}
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
                {/* CS13.3 — composite is chain machinery; hidden when Grok runs the family shot */}
                {isMultiPersonFamily && !xaiWillRun && (
                  <label className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border bg-card/60 px-3 py-2">
                    <span className="text-[11px] leading-snug text-muted">
                      🛡 প্রোটেক্টেড কম্পোজিট{' '}
                      <span className="rounded bg-[#81B29A]/15 px-1 py-px text-[9px] font-bold text-[#2d6a4f]">নতুন</span>
                      <br />
                      <span className="text-[10px]">
                        অনুমোদিত মুখ/গার্মেন্ট আর রিজেনারেট হয় না — কাটআউট বসিয়ে শুধু কিনারা+ছায়া মেলানো হয়
                      </span>
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
                {fidelityCapability && mode !== 'image_to_video' && (
                  <div className="mb-2 rounded-xl border border-border bg-card/60 px-3 py-2 text-[10.5px] leading-snug text-muted">
                    <span className="font-bold text-cream">
                      {fidelityCapability.fidelity === 'purpose_built' ? '✓ Purpose-built fidelity' : '◌ Identity-guided generation'}
                    </span>
                    {' · '}
                    {[
                      productPath ? 'product পাঠানো হবে' : null,
                      modelPath || modelId ? 'বাছাই করা person পাঠানো হবে' : null,
                    ].filter(Boolean).join(' · ') || 'text-only'}
                    {fidelityCapability.limitationBn ? ` — ${fidelityCapability.limitationBn}` : ''}
                    {selectedAdvancedEngine === 'xai_imagine' && resolution === '4k' ? ' — 4K অনুরোধ xAI-তে 2K হবে।' : ''}
                    {selectedAdvancedEngine === 'xai_imagine' ? ' — generation mode xAI ব্যবহার করে না।' : ''}
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
                    // CS13.3: the engine pick WINS everywhere xAI actually runs.
                    <>
                      Run —{' '}
                      {xaiWillRun
                        ? ENGINE_LABELS_BN.xai_imagine
                        : isMultiPersonFamily
                          ? FAMILY_CHAIN_LABEL_BN
                          : isSingleTryOn
                            ? (VTON_ENGINE_LABELS[vtonEngine] ?? vtonEngine)
                            : effectiveProvider === 'fashn'
                              ? 'FASHN Pro'
                              : 'Gemini'}
                    </>
                  )}
                </motion.button>
                <p className="mt-1.5 text-center text-[10px] text-muted">
                  {xaiWillRun
                    ? isFamilyMerge
                      ? 'Grok Imagine: দুই ছবির সবাইকে এক ফ্রেমে — মুখ/পোশাক হুবহু রেখে'
                      : isMultiPersonFamily
                        ? 'Grok Imagine multi-reference: দুজনের মডেল ছবি + প্রোডাক্ট এক কলে'
                        : 'Grok Imagine — product/person reference দুটিই পাঠাবে; ফল identity-guided, dedicated VTON নয়'
                    : isMultiPersonFamily
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

        <UploadTile label="Product ছবি" preview={productPreview} onFile={onProduct} required />

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
              <p className="text-[10px] text-muted">{`🟢 ${defaultEngineLabel} — ডিফল্ট ইঞ্জিন চালু`}</p>
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
              className={cn('relative h-6 w-10 shrink-0 rounded-full transition-colors', includeFamily ? 'bg-[#E07A5F]' : 'bg-white/15')}
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
          <span className={cn('relative h-6 w-10 shrink-0 rounded-full transition-colors', includeReel ? 'bg-[#E07A5F]' : 'bg-white/15')}>
            <span
              className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', includeReel ? 'left-[1.125rem]' : 'left-0.5')}
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
          ইঞ্জিন: {defaultEngineLabel} · সাপ্লায়ার ছবির প্লেট/টেক্সট অটো-ক্লিন
          {includeReel ? ' · রিলে আলাদা ভিডিও খরচ' : ''}
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

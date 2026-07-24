'use client'

import {
  buildAvatar,
  clearAvatarImages,
  deleteModel,
  fetchAvatar,
  fetchBrandStatus,
  fetchModels,
  generateBrandModel,
  saveBrandLogo,
  saveModel,
  setAvatarImages,
  setDefaultModel,
  uploadStudioFile,
  type BrandStatus,
  type StudioModelAvatar,
} from '@/agent/components/creative-studio/studio-api'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'react-hot-toast'

import { FinishPanel } from '@/agent/components/creative-studio/GalleryView'
import { StudioSettingsView } from '@/agent/components/creative-studio/StudioSettingsView'
import { downloadStudioAsset, UserSvg } from '@/agent/components/creative-studio/StudioUi'
import { MODEL_ROLES, roleLabelBn, type StudioModel } from '@/agent/components/creative-studio/StudioWorkspaceView'

function AvatarSheet({ model, onClose }: { model: StudioModel; onClose: () => void }) {
  const [avatar, setAvatar] = useState<StudioModelAvatar | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [canonical, setCanonical] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    const d = await fetchAvatar(model.id)
    setAvatar(d.avatar)
    setLoading(false)
  }, [model.id])

  useEffect(() => {
    void reload().catch(() => setLoading(false))
  }, [reload])

  const paths = avatar?.imagePaths ?? []

  const addFiles = async (files: FileList) => {
    const room = 10 - paths.length
    const list = Array.from(files).slice(0, Math.max(0, room))
    if (list.length === 0) {
      toast.error('সর্বোচ্চ ১০টি ছবি')
      return
    }
    setUploading(true)
    try {
      const uploaded: string[] = []
      for (const f of list) uploaded.push(await uploadStudioFile(f, 'model-avatar'))
      await setAvatarImages(model.id, [...paths, ...uploaded])
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const removeAt = async (i: number) => {
    const next = paths.filter((_, idx) => idx !== i)
    try {
      if (next.length === 0) await clearAvatarImages(model.id)
      else await setAvatarImages(model.id, next)
      await reload()
    } catch {
      toast.error('হয়নি')
    }
  }

  const startBuild = async () => {
    setBuilding(true)
    try {
      await buildAvatar(model.id, canonical)
      toast.success('Avatar তৈরি হচ্ছে — একটু পরে ব্যাজ সবুজ হবে')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Build failed')
      setBuilding(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm md:items-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 60 }}
        animate={{ y: 0 }}
        exit={{ y: 60 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-border bg-bg-1 p-4 shadow-2xl md:rounded-3xl"
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-cream">🧬 Avatar — {model.name}</h3>
          <button type="button" onClick={onClose} className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-muted">
            বন্ধ
          </button>
        </div>
        <p className="mb-3 text-[11px] leading-snug text-muted">
          বিভিন্ন অ্যাঙ্গেলের সর্বোচ্চ ১০টি ছবি দিন (সামনে, পাশ, থ্রি-কোয়ার্টার…)। সব অ্যাঙ্গেল মিলিয়ে আইডেন্টিটি শিট (ফ্রি) + Grok
          canonical পোর্ট্রেট (~$0.07) তৈরি হবে — এরপর এই মডেলের সব রেন্ডারে মুখের accuracy আরও ভালো হবে। পুরনো এক-ছবির সিস্টেমও আগের মতোই
          কাজ করবে।
        </p>

        {loading ? (
          <p className="py-6 text-center text-[12px] text-muted">লোড হচ্ছে…</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {paths.map((p, i) => (
                <div key={p} className="relative aspect-[3/4] overflow-hidden rounded-xl border border-border-subtle bg-card/60">
                  {avatar?.imageUrls?.[i] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatar.imageUrls[i] as string} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-[10px] text-muted">ছবি {i + 1}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeAt(i)}
                    className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/60 text-[10px] text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {paths.length < 10 && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                  className="grid aspect-[3/4] place-items-center rounded-xl border-2 border-dashed border-[#E07A5F]/35 bg-[#E07A5F]/[0.05] text-2xl text-[#E07A5F] disabled:opacity-50"
                >
                  {uploading ? '…' : '+'}
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {paths.length}/10 ছবি
              {avatar?.builtAt ? ` · সর্বশেষ build: ${new Date(avatar.builtAt).toLocaleString()}` : ''}
            </p>

            {(avatar?.canonicalUrl || avatar?.sheetUrl) && (
              <div className="mt-3 flex gap-2">
                {avatar?.canonicalUrl && (
                  <div className="flex-1">
                    <p className="mb-1 text-[10px] font-semibold text-muted">Canonical পোর্ট্রেট</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={avatar.canonicalUrl} alt="canonical" className="w-full rounded-xl border border-border-subtle" />
                  </div>
                )}
                {avatar?.sheetUrl && (
                  <div className="flex-1">
                    <p className="mb-1 text-[10px] font-semibold text-muted">আইডেন্টিটি শিট</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={avatar.sheetUrl} alt="sheet" className="w-full rounded-xl border border-border-subtle" />
                  </div>
                )}
              </div>
            )}

            <label className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">Grok canonical পোর্ট্রেটও বানাও (~$0.07 · best accuracy)</span>
              <input
                type="checkbox"
                checked={canonical}
                onChange={(e) => setCanonical(e.target.checked)}
                className="h-4 w-4 accent-[#E07A5F]"
              />
            </label>
            <button
              type="button"
              disabled={building || paths.length === 0 || Boolean(avatar?.building)}
              onClick={() => void startBuild()}
              className={cn(
                'mt-2 w-full rounded-xl py-3 text-[13px] font-bold text-white',
                paths.length > 0 && !building && !avatar?.building ? 'bg-[#E07A5F]' : 'bg-[#94A3B8]',
              )}
            >
              {avatar?.building ? 'Avatar তৈরি হচ্ছে…' : building ? '…' : avatar?.builtAt ? 'Avatar আবার বানাও' : 'Avatar বানাও'}
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

function ModelsView() {
  const [models, setModels] = useState<StudioModel[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // CS14 — which model's avatar sheet is open
  const [avatarModel, setAvatarModel] = useState<StudioModel | null>(null)
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
    setDraftPreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return null
    })
  }, [])

  const onPickFile = (f: File) => {
    setDraftPreview((p) => {
      if (p) URL.revokeObjectURL(p)
      return URL.createObjectURL(f)
    })
    setDraftPath(null)
    setDraftUploading(true)
    void uploadStudioFile(f, 'model-library')
      .then((p) => setDraftPath(p))
      .catch((err) => {
        toast.error(String(err))
        closeDraft()
      })
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
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[#E07A5F]/12 text-2xl leading-none transition-transform group-active:scale-95">
            +
          </span>
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

              {/* CS14 — avatar status badge */}
              {m.avatar && (m.avatar.built || m.avatar.building) && (
                <span
                  className={cn(
                    'absolute left-2 rounded-full px-2 py-0.5 text-[9px] font-bold text-white shadow-sm',
                    m.isDefault ? 'top-8' : 'top-2',
                    m.avatar.building ? 'bg-amber-500' : 'bg-[#81B29A]',
                  )}
                >
                  🧬 {m.avatar.building ? 'Avatar হচ্ছে…' : 'Avatar'}
                </span>
              )}

              {/* action buttons (top-right) */}
              <div className="absolute right-1.5 top-1.5 flex gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAvatarModel(m)}
                  title="Avatar — বিভিন্ন অ্যাঙ্গেলের ছবি"
                  className="grid h-7 w-7 place-items-center rounded-full bg-black/45 text-[12px] text-white backdrop-blur-sm transition-colors hover:bg-black/65 disabled:opacity-50"
                >
                  🧬
                </button>
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
      <StudioSettingsView />

      {/* CS14 — avatar sheet */}
      <AnimatePresence>
        {avatarModel && (
          <AvatarSheet
            model={avatarModel}
            onClose={() => {
              setAvatarModel(null)
              void load()
            }}
          />
        )}
      </AnimatePresence>

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
              style={{
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
              }}
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-[15px] font-bold text-cream">নতুন মডেল যোগ করুন</h3>
                <button
                  type="button"
                  onClick={() => !saving && closeDraft()}
                  className="grid h-7 w-7 place-items-center rounded-full bg-white/8 text-muted"
                >
                  ✕
                </button>
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
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> সেভ হচ্ছে…
                  </>
                ) : draftUploading ? (
                  'ছবি আপলোড হচ্ছে…'
                ) : (
                  'সেভ করুন'
                )}
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
                .then(() => {
                  toast.success(`${r.bn} মডেল তৈরি হচ্ছে — Gallery-তে আসবে`)
                  onQueued()
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[11px] font-semibold',
              have.has(r.id) ? 'bg-white/10 text-muted' : 'bg-[#E07A5F] text-white',
            )}
          >
            {r.bn}
            {have.has(r.id) ? ' ✓ আছে' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

/** CS4 — QC level + Telegram done-ping + child-garment cache management. */

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
    void fetchBrandStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
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
        লোগো, রং আর ফন্ট আপনার ব্র্যান্ড সেটিং থেকেই আসে। কোড আর hook প্রতিটা ছবির জন্য আলাদা করে এখানে লিখবেন — Gallery-র যেকোনো ছবিতে
        &quot;ফিনিশিং&quot; চাপলেও একই অপশন আসবে। আসল ছবি অক্ষত থাকে, আলাদা একটা ব্র্যান্ডেড কপি তৈরি হয়।
      </p>

      {status && !status.hasLogo && (
        <div className="mb-4 rounded-xl border border-[#C89B3C]/40 bg-[#C89B3C]/10 px-3 py-2.5 text-[11px] leading-snug text-[#C89B3C]">
          ⚠️ এখনো কোনো লোগো আপলোড করা হয়নি, বস। লোগো ছাড়া ফিনিশিং করলে ছবিতে শুধু লেখা আর রং বসবে, লোগো বসবে না। নিচে একবার আপনার লোগো
          আপলোড করে নিন — এরপর প্রতিটা ফিনিশিং-এ এটাই বসবে।
        </div>
      )}

      {/* ── Brand logo (changeable) ──────────────────────────────────────────── */}
      <h3 className="mb-1.5 text-[12px] font-bold text-cream">ব্র্যান্ড লোগো</h3>
      <p className="mb-2 text-[11px] leading-snug text-muted">
        যেকোনো সাইজ চলবে — সিস্টেম নিজে রিসাইজ করে নেবে। সবচেয়ে ভালো: PNG (transparent background)। লোগো বদলাতে চাইলে নতুনটা আপলোড করে সেভ
        করুন।
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
            style={{
              background: 'repeating-conic-gradient(#0000000d 0% 25%, transparent 0% 50%) 50% / 16px 16px',
            }}
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
      <p className="mb-2 text-[11px] leading-snug text-muted">নিজের একটা ছবি আপলোড করুন, তারপর সেই ছবির কোড আর hook লিখে ফিনিশিং করুন।</p>
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
            onClick={() => downloadStudioAsset(resultUrl, `alma-finished-${Date.now()}.jpg`)}
            className="flex-1 rounded-xl bg-[#E07A5F] py-2.5 text-center text-sm font-bold text-white"
          >
            ডাউনলোড
          </button>
          <button
            type="button"
            onClick={() => {
              setResultUrl(null)
            }}
            className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-muted"
          >
            আবার ফিনিশিং
          </button>
        </div>
      )}
    </div>
  )
}

export function ModelLibraryView() {
  return (
    <div className="pb-24">
      <ModelsView />
      <div className="mx-3 my-1 border-t border-border-subtle" />
      <FinishingView />
    </div>
  )
}

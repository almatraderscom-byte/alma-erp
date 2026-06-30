'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'

// ── Types (mirror src/agent/lib/catalog/product-images.ts) ──────────────────────
type CatalogImageGroup = {
  code: string
  name: string
  category: string
  kind: 'collection' | 'sku'
  members: string[]
  imageCount: number
  hasImages: boolean
  primaryImageUrl: string | null
}

type CatalogResponse = {
  ok: boolean
  groups: CatalogImageGroup[]
  totalGroups: number
  withImages: number
  missing: number
}

type ProductImageEntry = {
  id: string
  url: string | null
  storagePath: string
  isPrimary: boolean
}

type Filter = 'all' | 'missing' | 'with'

export default function CatalogImagesScreen({ canDelete = false }: { canDelete?: boolean }) {
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [active, setActive] = useState<CatalogImageGroup | null>(null)
  // True when `active` is a brand-new custom product (not from ERP inventory) —
  // its uploads go through the allowNew path.
  const [activeIsNew, setActiveIsNew] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [newCode, setNewCode] = useState('')

  const openNew = useCallback(() => {
    const code = newCode.trim().toUpperCase()
    if (!code) return
    setActive({
      code,
      name: code,
      category: 'কাস্টম',
      kind: 'sku',
      members: [code],
      imageCount: 0,
      hasImages: false,
      primaryImageUrl: null,
    })
    setActiveIsNew(true)
    setShowNew(false)
    setNewCode('')
  }, [newCode])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/assistant/catalog/products', { cache: 'no-store' })
      const json = (await res.json()) as CatalogResponse & { error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'লোড করা গেল না')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.groups.filter((g) => {
      if (filter === 'missing' && g.hasImages) return false
      if (filter === 'with' && !g.hasImages) return false
      if (!q) return true
      return (
        g.code.toLowerCase().includes(q) ||
        g.name.toLowerCase().includes(q) ||
        g.category.toLowerCase().includes(q) ||
        g.members.some((m) => m.toLowerCase().includes(q))
      )
    })
  }, [data, query, filter])

  return (
    <div className="h-full min-h-0 overflow-y-auto pb-24">
      <AgentSubHeader title="প্রোডাক্ট ছবি" subtitle="ছবি দেখুন ও আপলোড করুন — ফ্যামিলি সেটে স্বয়ংক্রিয় যোগ হয়" />
      <div className="mx-auto w-full max-w-5xl px-4 py-5">
        {/* Summary */}
        {data && (
          <div className="mb-4 grid grid-cols-3 gap-2">
            <SummaryCard label="মোট প্রোডাক্ট" value={data.totalGroups} tone="neutral" />
            <SummaryCard label="ছবি আছে" value={data.withImages} tone="good" />
            <SummaryCard label="ছবি নেই" value={data.missing} tone="warn" />
          </div>
        )}

        {/* Controls */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="কোড / নাম / ক্যাটাগরি খুঁজুন…"
            className="w-full rounded-xl border border-border-subtle bg-white/[0.04] px-3 py-2 text-sm text-cream placeholder:text-muted focus:border-[#3D8BFD]/40 focus:outline-none"
          />
          <div className="flex shrink-0 gap-1">
            {(['all', 'missing', 'with'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs font-medium transition-all',
                  filter === f
                    ? 'border-[#3D8BFD]/40 bg-[#3D8BFD]/10 text-[#3D8BFD]'
                    : 'border-border-subtle bg-white/[0.04] text-muted hover:text-muted-hi',
                )}
              >
                {f === 'all' ? 'সব' : f === 'missing' ? 'ছবি নেই' : 'ছবি আছে'}
              </button>
            ))}
          </div>
        </div>

        {/* Add a brand-new product (not yet in ERP inventory) */}
        <div className="mb-4">
          {!showNew ? (
            <button
              onClick={() => setShowNew(true)}
              className="w-full rounded-xl border border-dashed border-[#3D8BFD]/40 bg-[#3D8BFD]/5 px-3 py-2.5 text-sm font-medium text-[#3D8BFD] transition-colors hover:bg-[#3D8BFD]/10"
            >
              ➕ নতুন প্রোডাক্ট যোগ করুন
            </button>
          ) : (
            <div className="rounded-xl border border-[#3D8BFD]/30 bg-white/[0.04] p-3">
              <div className="mb-2 text-xs font-medium text-cream">নতুন প্রোডাক্ট কোড</div>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && openNew()}
                  placeholder="যেমন: ALM-999"
                  maxLength={32}
                  className="w-full rounded-lg border border-border-subtle bg-white/[0.04] px-3 py-2 text-sm uppercase text-cream placeholder:normal-case placeholder:text-muted focus:border-[#3D8BFD]/40 focus:outline-none"
                />
                <button
                  onClick={openNew}
                  disabled={!newCode.trim()}
                  className="shrink-0 rounded-lg bg-[#3D8BFD] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  ছবি যোগ করুন
                </button>
                <button
                  onClick={() => { setShowNew(false); setNewCode('') }}
                  className="shrink-0 rounded-lg border border-border-subtle px-3 py-2 text-sm text-muted"
                >
                  বাতিল
                </button>
              </div>
              <div className="mt-1.5 text-[10px] text-muted">
                ERP inventory-তে নেই এমন নতুন কোডের জন্য — ছবি দিলে এটি তালিকায় যোগ হবে।
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        {loading && <div className="py-12 text-center text-sm text-muted">লোড হচ্ছে…</div>}
        {error && !loading && (
          <div className="rounded-xl border border-red-400/30 bg-red-500/5 p-4 text-center text-sm text-red-300">
            {error}
            <button onClick={load} className="ml-2 underline">
              আবার চেষ্টা করুন
            </button>
          </div>
        )}
        {!loading && !error && data && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((g) => (
              <ProductCard key={g.code} group={g} onOpen={() => { setActiveIsNew(false); setActive(g) }} />
            ))}
            {filtered.length === 0 && (
              <div className="col-span-full py-10 text-center text-sm text-muted">কোনো প্রোডাক্ট মিলল না।</div>
            )}
          </div>
        )}
      </div>

      {active && (
        <ProductDetail
          group={active}
          canDelete={canDelete}
          isNew={activeIsNew}
          onClose={() => { setActive(null); setActiveIsNew(false) }}
          onChanged={() => {
            load()
          }}
        />
      )}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'good' | 'warn' }) {
  const toneCls =
    tone === 'good' ? 'text-[#81B29A]' : tone === 'warn' ? 'text-amber-400' : 'text-cream'
  return (
    <div className="rounded-xl border border-border-subtle bg-white/[0.04] px-3 py-2.5 text-center">
      <div className={cn('text-xl font-bold', toneCls)}>{value}</div>
      <div className="mt-0.5 text-[10px] text-muted">{label}</div>
    </div>
  )
}

function ProductCard({ group, onOpen }: { group: CatalogImageGroup; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-white/[0.04] text-left transition-all hover:border-[#3D8BFD]/30 hover:bg-white/[0.06]"
    >
      <div className="relative aspect-square w-full bg-black/20">
        {group.primaryImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={group.primaryImageUrl} alt={group.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl text-muted/40">🖼️</div>
        )}
        {/* count badge */}
        <span
          className={cn(
            'absolute right-1.5 top-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold',
            group.hasImages ? 'bg-[#81B29A]/90 text-white' : 'bg-amber-500/90 text-white',
          )}
        >
          {group.hasImages ? `${group.imageCount} ছবি` : 'ছবি নেই'}
        </span>
        {group.kind === 'collection' && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-[#3D8BFD]/90 px-2 py-0.5 text-[10px] font-bold text-white">
            সেট ×{group.members.length}
          </span>
        )}
      </div>
      <div className="p-2">
        <div className="truncate text-xs font-semibold text-cream">{group.code}</div>
        <div className="truncate text-[10px] text-muted">{group.name || group.category || '—'}</div>
      </div>
    </button>
  )
}

function ProductDetail({
  group,
  canDelete,
  isNew,
  onClose,
  onChanged,
}: {
  group: CatalogImageGroup
  canDelete: boolean
  isNew: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [images, setImages] = useState<ProductImageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Confirm-before-upload: files are STAGED here on pick/drop and only sent when
  // the owner taps "আপলোড করুন". Each carries an object URL for preview.
  const [pending, setPending] = useState<{ file: File; url: string }[]>([])
  // Two-tap delete confirm (id of the image awaiting confirm), so a tap can't
  // accidentally delete.
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadImages = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/assistant/catalog/images/${encodeURIComponent(group.code)}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok && json.ok) setImages(json.images as ProductImageEntry[])
      else setImages([])
    } catch {
      setImages([])
    } finally {
      setLoading(false)
    }
  }, [group.code])

  useEffect(() => {
    loadImages()
  }, [loadImages])

  // Revoke any staged object URLs on unmount.
  useEffect(() => () => { pending.forEach((p) => URL.revokeObjectURL(p.url)) }, [pending])

  const stage = useCallback((files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
    if (!list.length) return
    setNote(null)
    setPending((prev) => [...prev, ...list.map((file) => ({ file, url: URL.createObjectURL(file) }))])
  }, [])

  const removePending = useCallback((idx: number) => {
    setPending((prev) => {
      const next = [...prev]
      const [gone] = next.splice(idx, 1)
      if (gone) URL.revokeObjectURL(gone.url)
      return next
    })
  }, [])

  const clearPending = useCallback(() => {
    setPending((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url))
      return []
    })
  }, [])

  const confirmUpload = useCallback(async () => {
    if (!pending.length) return
    setBusy(true)
    setNote(null)
    try {
      const fd = new FormData()
      for (const p of pending) fd.append('file', p.file)
      if (isNew) fd.append('allowNew', '1')
      const res = await fetch(`/api/assistant/catalog/images/${encodeURIComponent(group.code)}`, {
        method: 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setNote(json.error === 'invalid_code' ? 'কোডটি ERP inventory-তে নেই।' : `আপলোড ব্যর্থ: ${json.error || res.status}`)
      } else {
        setNote(`${json.uploaded}টি ছবি যোগ হয়েছে।`)
        clearPending()
        await loadImages()
        onChanged()
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'আপলোড ব্যর্থ')
    } finally {
      setBusy(false)
    }
  }, [pending, isNew, group.code, clearPending, loadImages, onChanged])

  const remove = useCallback(
    async (imageId: string) => {
      setBusy(true)
      setNote(null)
      setConfirmDel(null)
      try {
        const res = await fetch(
          `/api/assistant/catalog/images/${encodeURIComponent(group.code)}?imageId=${encodeURIComponent(imageId)}`,
          { method: 'DELETE' },
        )
        const json = await res.json()
        if (!res.ok || !json.ok) setNote(`মুছতে ব্যর্থ: ${json.error || res.status}`)
        else {
          setNote(`ছবি মুছে ফেলা হয়েছে।`)
          await loadImages()
          onChanged()
        }
      } catch (err) {
        setNote(err instanceof Error ? err.message : 'মুছতে ব্যর্থ')
      } finally {
        setBusy(false)
      }
    },
    [group.code, loadImages, onChanged],
  )

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-border-subtle bg-card sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* head */}
        <div className="flex items-start justify-between border-b border-border-subtle p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-cream">{group.code}</span>
              {isNew && (
                <span className="rounded-full bg-[#81B29A]/15 px-2 py-0.5 text-[10px] font-bold text-[#81B29A]">
                  নতুন
                </span>
              )}
              {group.kind === 'collection' && (
                <span className="rounded-full bg-[#3D8BFD]/15 px-2 py-0.5 text-[10px] font-bold text-[#3D8BFD]">
                  ফ্যামিলি সেট ×{group.members.length}
                </span>
              )}
            </div>
            <div className="truncate text-xs text-muted">{group.name || group.category || '—'}</div>
            {group.kind === 'collection' && (
              <div className="mt-1 text-[10px] text-muted">মেম্বার: {group.members.join(', ')}</div>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:text-muted-hi">
            ✕
          </button>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4">
          {isNew && (
            <p className="mb-3 rounded-lg border border-[#81B29A]/20 bg-[#81B29A]/5 px-3 py-2 text-[11px] text-[#9fd3bb]">
              নতুন প্রোডাক্ট <b>{group.code}</b> — ছবি বেছে নিয়ে আপলোড করলে এটি তালিকায় যোগ হবে।
            </p>
          )}
          {group.kind === 'collection' && (
            <p className="mb-3 rounded-lg border border-[#3D8BFD]/20 bg-[#3D8BFD]/5 px-3 py-2 text-[11px] text-[#9cc0ff]">
              এটি ফ্যামিলি ম্যাচিং সেট — এখানে আপলোড করা ছবি সেটের সব {group.members.length}টি মেম্বারে যোগ হবে।
            </p>
          )}

          {/* dropzone — picks STAGE files (no auto-upload) */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files?.length) stage(e.dataTransfer.files)
            }}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'mb-4 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition-all',
              dragOver ? 'border-[#3D8BFD] bg-[#3D8BFD]/10' : 'border-border-subtle bg-white/[0.03] hover:border-[#3D8BFD]/40',
            )}
          >
            <div className="text-2xl">🖼️</div>
            <div className="mt-1 text-sm font-medium text-cream">ছবি বেছে নিন</div>
            <div className="text-[11px] text-muted">ট্যাপ করুন বা টেনে আনুন — দেখে নিয়ে তারপর আপলোড করবেন</div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) stage(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          {/* staged previews + confirm/cancel */}
          {pending.length > 0 && (
            <div className="mb-4 rounded-xl border border-[#81B29A]/30 bg-[#81B29A]/5 p-3">
              <div className="mb-2 text-xs font-medium text-cream">আপলোডের জন্য প্রস্তুত ({pending.length}) — দেখে নিন</div>
              <div className="grid grid-cols-4 gap-2">
                {pending.map((p, i) => (
                  <div key={i} className="relative aspect-square overflow-hidden rounded-lg bg-black/20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt="" className="h-full w-full object-cover" />
                    <button
                      disabled={busy}
                      onClick={() => removePending(i)}
                      className="absolute right-0.5 top-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[11px] text-white hover:bg-red-500 disabled:opacity-40"
                      title="সরান"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy}
                  onClick={confirmUpload}
                  className="flex-1 rounded-lg bg-[#81B29A] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? 'আপলোড হচ্ছে…' : `আপলোড করুন (${pending.length})`}
                </button>
                <button
                  disabled={busy}
                  onClick={clearPending}
                  className="rounded-lg border border-border-subtle px-3 py-2 text-sm text-muted disabled:opacity-40"
                >
                  সব বাতিল
                </button>
              </div>
            </div>
          )}

          {note && <div className="mb-3 text-center text-xs text-[#81B29A]">{note}</div>}

          {/* gallery */}
          {loading ? (
            <div className="py-8 text-center text-sm text-muted">লোড হচ্ছে…</div>
          ) : images.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">এখনো কোনো ছবি নেই।</div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((img) => (
                <div key={img.id} className="relative aspect-square overflow-hidden rounded-lg bg-black/20">
                  {img.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted/40">—</div>
                  )}
                  {img.isPrimary && (
                    <span className="absolute left-1 top-1 rounded bg-[#E07A5F]/90 px-1.5 py-0.5 text-[9px] font-bold text-white">
                      প্রধান
                    </span>
                  )}
                  {/* Delete — always visible (works on touch), two-tap confirm */}
                  {canDelete && (
                    confirmDel === img.id ? (
                      <div className="absolute right-1 top-1 flex gap-1">
                        <button
                          disabled={busy}
                          onClick={() => remove(img.id)}
                          className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white disabled:opacity-40"
                          title="নিশ্চিত মুছুন"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => setConfirmDel(null)}
                          className="rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white"
                          title="বাতিল"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmDel(img.id)}
                        className="absolute right-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[11px] text-white hover:bg-red-500 disabled:opacity-40"
                        title="মুছুন"
                      >
                        🗑
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

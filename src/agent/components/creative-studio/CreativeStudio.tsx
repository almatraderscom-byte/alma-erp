'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import toast from 'react-hot-toast'
import { brandTodo } from '@/agent/components/todo-brand-tokens'
import { cn } from '@/lib/utils'

type ChatTryOnVariant =
  | 'single'
  | 'father_son'
  | 'mother_son'
  | 'mother_daughter'
  | 'full_family'

type StudioTab = 'brief' | 'models' | 'tryon'
type BriefKind = 'reel' | 'fb_post' | 'ad_hook' | 'story'
type ViewMode = 'studio' | 'chat'

type SavedModelRow = {
  id: string
  name: string
  role: string | null
  isDefault: boolean
  notes?: string
}

type Product = { code: string; name: string; type: string }

const TABS: Array<{ id: StudioTab; label: string; sub: string }> = [
  { id: 'brief', label: 'Creative Brief', sub: 'Hooks & captions' },
  { id: 'models', label: 'Model Library', sub: 'Save your face' },
  { id: 'tryon', label: 'Try-On', sub: 'Product → model' },
]

const ROLES = [
  { id: 'single', label: 'Single / Owner' },
  { id: 'father', label: 'Father' },
  { id: 'mother', label: 'Mother' },
  { id: 'son', label: 'Son (5–12)' },
  { id: 'daughter', label: 'Daughter (5–10)' },
] as const

const VARIANT_OPTS: Array<{ id: ChatTryOnVariant; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'father_son', label: 'Baba + Chele' },
  { id: 'mother_son', label: 'Ma + Chele' },
  { id: 'mother_daughter', label: 'Ma + Meyе' },
  { id: 'full_family', label: 'Full family' },
]

const spring = { type: 'spring' as const, stiffness: 420, damping: 32 }

function Pressable({
  className,
  children,
  disabled,
  onClick,
  type = 'button',
}: {
  className?: string
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
}) {
  return (
    <motion.div whileHover={disabled ? undefined : { scale: 1.02, y: -1 }} whileTap={disabled ? undefined : { scale: 0.97 }} transition={spring}>
      <button type={type} disabled={disabled} onClick={onClick} className={className}>
        {children}
      </button>
    </motion.div>
  )
}

async function uploadFile(file: File, folder: string): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('conversationId', folder)
  const res = await fetch('/api/assistant/upload', { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'upload_failed')
  return data.path as string
}

// --- Brief mock (Phase C lite preview) ---
const PRODUCTS: Product[] = [
  { code: 'ALM-8842', name: 'Premium Cotton Panjabi', type: 'panjabi' },
  { code: 'ALM-7710', name: 'Embroidered Kurti Set', type: 'kurti' },
  { code: 'ALM-5521', name: 'Father-Son Combo', type: 'family_match' },
]

const MOCK_BRIEFS: Record<BriefKind, (p: Product) => { title: string; concept: string; hooks: string[] }> = {
  reel: (p) => ({
    title: `${p.name} — রিল ব্রিফ`,
    concept: 'ঈদ vibe — fabric close-up → full reveal → Inbox CTA।',
    hooks: ['Premium fabric feel', 'Baba-chele combo', 'Dhaka heat comfortable'],
  }),
  fb_post: (p) => ({
    title: `${p.name} — FB পোস্ট`,
    concept: 'Gate 1 fabric check → Gate 2 publish।',
    hooks: ['Limited stock', 'Office + jamaat friendly', 'Photo = product'],
  }),
  ad_hook: (p) => ({
    title: `${p.name} — Ad hooks`,
    concept: '3 hooks × separate ad sets, kill after 48h.',
    hooks: ['Eid shopping bookmark', 'COD risk-free', 'Inbox now'],
  }),
  story: (p) => ({
    title: `${p.name} — Story arc`,
    concept: '3 slides: hook → detail → CTA.',
    hooks: ['Swipe fabric macro', 'DM for size', 'Today deal'],
  }),
}

function BriefPanel() {
  const [kind, setKind] = useState<BriefKind>('reel')
  const [product, setProduct] = useState(PRODUCTS[0])
  const [view, setView] = useState<ViewMode>('studio')
  const [generating, setGenerating] = useState(false)
  const brief = useMemo(() => MOCK_BRIEFS[kind](product), [kind, product])

  const regenerate = () => {
    setGenerating(true)
    window.setTimeout(() => setGenerating(false), 900)
  }

  return (
    <div className="space-y-3">
      <div className="flex rounded-xl border border-black/[0.06] bg-white/80 p-1">
        {(['studio', 'chat'] as const).map((v) => (
          <Pressable
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              'flex-1 rounded-lg py-2 text-xs font-semibold transition-colors',
              view === v ? `${brandTodo.coralBtn} text-white shadow-sm` : 'text-[#1a1a2e]/55',
            )}
          >
            {v === 'studio' ? 'Studio view' : 'Chat view'}
          </Pressable>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ['reel', 'রিল'],
            ['fb_post', 'FB'],
            ['ad_hook', 'Ad'],
            ['story', 'Story'],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            type="button"
            onClick={() => {
              setKind(id)
              regenerate()
            }}
            className={cn(
              'rounded-xl border px-2 py-2 text-xs font-bold transition-all',
              kind === id ? `${brandTodo.coralBorder} ${brandTodo.coralBgStrong}` : 'border-black/[0.06] bg-white/85',
            )}
          >
            {label}
          </Pressable>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {view === 'studio' ? (
          <motion.div key="s" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-2">
            <motion.h2 layout className="text-base font-bold text-[#1a1a2e]">
              {generating ? '…' : brief.title}
            </motion.h2>
            <motion.div layout className={cn('rounded-xl p-3', brandTodo.agentCard)}>
              <p className={cn('text-[10px] font-bold uppercase', brandTodo.coralDark)}>Concept</p>
              <p className="mt-1 text-[13px] leading-relaxed">{brief.concept}</p>
            </motion.div>
            <motion.div layout className={cn('rounded-xl p-3', brandTodo.agentCard)}>
              <p className={cn('text-[10px] font-bold uppercase', brandTodo.coralDark)}>Hooks</p>
              <ul className="mt-1 list-disc pl-4 text-[12px]">
                {brief.hooks.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </motion.div>
          </motion.div>
        ) : (
          <motion.div key="c" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
            <div className={cn('ml-auto max-w-[85%] rounded-2xl rounded-br-md px-3 py-2 text-[13px]', brandTodo.bossFrame)}>
              {product.code} — ঈদ রিল idea দাও
            </div>
            <div className="max-w-[92%] rounded-2xl border border-black/[0.06] bg-white/95 px-3 py-3 text-[12px] shadow-sm">
              Sir, {brief.concept}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ModelsPanel() {
  const [models, setModels] = useState<SavedModelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('single')
  const [notes, setNotes] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/assistant/brand-models')
      const data = await res.json()
      if (res.ok) setModels(data.models ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onPick = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview)
    setFile(f)
    setPreview(f ? URL.createObjectURL(f) : null)
  }

  const save = async () => {
    if (!file || !name.trim()) {
      toast.error('নাম + ছবি দিন')
      return
    }
    setSaving(true)
    try {
      const imagePath = await uploadFile(file, 'model-library')
      const id = name.trim().toLowerCase().replace(/\s+/g, '-')
      const res = await fetch('/api/assistant/brand-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', id, name: name.trim(), imagePath, role, notes: notes || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'save_failed')
      toast.success(`Model "${name}" saved`)
      setName('')
      setNotes('')
      onPick(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-[#1a1a2e]/60">
        Full-body photo save করুন — chat-এ &quot;Model {name || 'Maruf'} use koro&quot; বললে agent এটা ব্যবহার করবে।
      </p>

      <motion.div
        layout
        className={cn(
          'relative overflow-hidden rounded-2xl border-2 border-dashed p-4 text-center transition-colors',
          preview ? brandTodo.coralBorderSoft : 'border-black/[0.1] bg-white/60',
        )}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        />
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Model preview" className="mx-auto max-h-48 rounded-xl object-contain" />
        ) : (
          <p className="py-8 text-sm font-semibold text-[#1a1a2e]/50">Tap to upload model photo</p>
        )}
      </motion.div>

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Model name (e.g. Maruf)"
          className="rounded-xl border border-black/[0.08] bg-white/90 px-3 py-2.5 text-sm outline-none focus:border-[#E07A5F]/40"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-xl border border-black/[0.08] bg-white/90 px-3 py-2.5 text-sm"
        >
          {ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (age, build — optional)"
        className="w-full rounded-xl border border-black/[0.08] bg-white/90 px-3 py-2.5 text-sm"
      />

      <Pressable
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className={cn('w-full rounded-xl py-3 text-sm font-bold text-white disabled:opacity-50', brandTodo.coralBtn)}
      >
        {saving ? 'Saving…' : 'Save to agent memory'}
      </Pressable>

      <div className="space-y-2">
        <p className={cn('text-xs font-bold', brandTodo.coralDark)}>Saved models</p>
        {loading ? (
          <p className="text-xs text-[#1a1a2e]/50">Loading…</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-[#1a1a2e]/50">No models yet — upload above or save via chat.</p>
        ) : (
          models.map((m) => (
            <motion.div
              key={m.id}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={cn('flex items-center justify-between rounded-xl px-3 py-2', brandTodo.agentCard)}
            >
              <div>
                <p className="text-sm font-semibold">{m.name}</p>
                <p className="text-[10px] text-[#1a1a2e]/55">
                  {m.role ?? '—'} {m.isDefault ? '· default' : ''}
                </p>
              </div>
              <span className="font-mono text-[10px] text-[#1a1a2e]/40">{m.id}</span>
            </motion.div>
          ))
        )}
      </div>
    </div>
  )
}

function TryOnPanel() {
  const [models, setModels] = useState<SavedModelRow[]>([])
  const [productFile, setProductFile] = useState<File | null>(null)
  const [productPreview, setProductPreview] = useState<string | null>(null)
  const [modelId, setModelId] = useState('')
  const [variants, setVariants] = useState<ChatTryOnVariant[]>(['single'])
  const [busy, setBusy] = useState(false)
  const productRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void fetch('/api/assistant/brand-models')
      .then((r) => r.json())
      .then((d) => setModels(d.models ?? []))
      .catch(() => {})
  }, [])

  const toggleVariant = (v: ChatTryOnVariant) => {
    setVariants((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
  }

  const run = async () => {
    if (!productFile) {
      toast.error('Product photo upload করুন')
      return
    }
    if (!variants.length) {
      toast.error('At least one variant')
      return
    }
    setBusy(true)
    try {
      const productImagePath = await uploadFile(productFile, 'tryon')
      const res = await fetch('/api/assistant/brand-models/tryon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productImagePath,
          modelId: modelId || undefined,
          variants,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'tryon_failed')
      toast.success(data.message ?? `${data.items?.length ?? variants.length} approval cards created`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Try-on failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-[#1a1a2e]/60">
        Reseller/mannequin product photo + saved model → Gemini try-on (garment unchanged, face from model). Approve in chat/Telegram.
      </p>

      <motion.div
        className={cn('rounded-2xl border-2 border-dashed p-3 text-center', productPreview ? brandTodo.coralBorderSoft : 'border-black/[0.1]')}
        onClick={() => productRef.current?.click()}
      >
        <input
          ref={productRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null
            if (productPreview) URL.revokeObjectURL(productPreview)
            setProductFile(f)
            setProductPreview(f ? URL.createObjectURL(f) : null)
          }}
        />
        {productPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={productPreview} alt="Product" className="mx-auto max-h-40 rounded-lg object-contain" />
        ) : (
          <p className="py-6 text-sm text-[#1a1a2e]/50">Upload product / mannequin photo</p>
        )}
      </motion.div>

      <select
        value={modelId}
        onChange={(e) => setModelId(e.target.value)}
        className="w-full rounded-xl border border-black/[0.08] bg-white/90 px-3 py-2.5 text-sm"
      >
        <option value="">Default model (single)</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.role})
          </option>
        ))}
      </select>

      <div className="flex flex-wrap gap-1.5">
        {VARIANT_OPTS.map((v) => (
          <Pressable
            key={v.id}
            type="button"
            onClick={() => toggleVariant(v.id)}
            className={cn(
              'rounded-full px-3 py-1.5 text-[11px] font-semibold',
              variants.includes(v.id) ? `${brandTodo.coralBtn} text-white` : 'border border-black/[0.08] bg-white/80',
            )}
          >
            {v.label}
          </Pressable>
        ))}
      </div>

      <Pressable
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className={cn(
          'relative w-full overflow-hidden rounded-xl py-3.5 text-sm font-bold text-white disabled:opacity-50',
          brandTodo.coralBtn,
        )}
      >
        {busy ? 'Creating approval cards…' : 'Generate try-on (approve in chat)'}
      </Pressable>
    </div>
  )
}

export default function CreativeStudio() {
  const [tab, setTab] = useState<StudioTab>('tryon')

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-3 pb-24 pt-3 sm:px-4">
      <motion.div
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn('mb-3 rounded-2xl border px-3 py-3', brandTodo.coralBorderSoft, brandTodo.coralBg)}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className={cn('text-sm font-bold', brandTodo.coralDark)}>Creative Studio</p>
            <p className="text-[11px] text-[#1a1a2e]/65">Brief · Model library · Virtual try-on</p>
          </div>
          <Link href="/agent" className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-white', brandTodo.coralBtn)}>
            ← Chat
          </Link>
        </div>
      </motion.div>

      <LayoutGroup>
        <div className="relative mb-3 flex gap-1 rounded-2xl border border-black/[0.06] bg-white/75 p-1">
          {TABS.map((t) => (
            <Pressable
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'relative z-10 flex-1 rounded-xl px-1 py-2 text-center transition-colors',
                tab === t.id ? 'text-white' : 'text-[#1a1a2e]/55',
              )}
            >
              {tab === t.id && (
                <motion.span
                  layoutId="studio-tab-pill"
                  transition={spring}
                  className={cn('absolute inset-0 rounded-xl', brandTodo.coralBtn)}
                />
              )}
              <span className="relative block text-[11px] font-bold leading-tight">{t.label}</span>
              <span className="relative block text-[9px] opacity-80">{t.sub}</span>
            </Pressable>
          ))}
        </div>
      </LayoutGroup>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.22 }}
          className="min-h-0 flex-1 overflow-y-auto pb-4"
        >
          {tab === 'brief' && <BriefPanel />}
          {tab === 'models' && <ModelsPanel />}
          {tab === 'tryon' && <TryOnPanel />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

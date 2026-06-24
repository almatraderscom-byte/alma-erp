'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { StaffOfficeData, StaffTaskCard, TaskThread, ThreadMessage } from '@/agent/lib/office-hub'

type StaffActionBody = {
  action: 'done' | 'proof' | 'comment' | 'update' | 'self_create'
  taskId?: string
  body?: string
  text?: string
  imageUrl?: string
  title?: string
  detail?: string
}

async function postStaff(body: StaffActionBody): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
  const res = await fetch('/api/assistant/office/staff-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = res.ok ? await res.json().catch(() => ({})) : undefined
  return { ok: res.ok, data }
}

async function uploadProof(file: File): Promise<string | null> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/assistant/office/upload', { method: 'POST', body: fd })
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string }
  return data.url ?? null
}

export default function StaffApp({ data }: { data: StaffOfficeData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const busy = pending || busyId !== null

  const run = useCallback(
    async (key: string, body: StaffActionBody) => {
      setBusyId(key)
      const { ok } = await postStaff(body)
      setBusyId(null)
      if (ok) startTransition(() => router.refresh())
      return ok
    },
    [router],
  )

  const needUpdate = data.active.filter((t) => t.needsUpdate)

  return (
    <div className="space-y-6">
      {/* Award */}
      {data.isWinner ? (
        <WinnerBanner name={data.staffName} />
      ) : (
        data.award && (
          <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-3 text-center">
            <p className="text-sm text-amber-200">🏆 এই সপ্তাহের সেরা: <span className="font-semibold text-white">{data.award.staffName}</span></p>
          </div>
        )
      )}

      {/* Update-requested alerts */}
      {needUpdate.length > 0 && (
        <section className="space-y-2">
          {needUpdate.map((t) => (
            <UpdateAlert key={t.id} t={t} busy={busy} onSend={(text) => run(`upd-${t.id}`, { action: 'update', taskId: t.id, body: text })} />
          ))}
        </section>
      )}

      {/* Active tasks */}
      {data.active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-white">আজকের কাজ</h2>
          {data.active.map((t) => (
            <StaffTaskCardView
              key={t.id}
              t={t}
              open={openId === t.id}
              busy={busy}
              onToggle={() => setOpenId(openId === t.id ? null : t.id)}
              onDone={() => run(`done-${t.id}`, { action: 'done', taskId: t.id })}
              onProof={async (url, text) => run(`proof-${t.id}`, { action: 'proof', taskId: t.id, imageUrl: url, text })}
              onComment={(text) => run(`cmt-${t.id}`, { action: 'comment', taskId: t.id, body: text })}
            />
          ))}
        </section>
      )}

      {data.active.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
          <p className="text-base font-medium text-white">আজ কোনো কাজ নেই</p>
          <p className="mt-2 text-sm text-slate-400">নতুন কাজ এলে এখানে দেখতে পাবেন।</p>
        </div>
      )}

      {/* Self-initiated */}
      <SelfInitiated
        proposals={data.proposals}
        busy={busy}
        onCreate={(title, detail) => run('self-create', { action: 'self_create', title, detail })}
      />

      {/* Done */}
      {data.done.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-slate-400">সম্পন্ন</h2>
          <div className="space-y-3 opacity-70">
            {data.done.map((t) => (
              <article key={t.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <h3 className="text-base font-medium text-white">{t.title} ✅</h3>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function WinnerBanner({ name }: { name: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-amber-400/40 bg-gradient-to-br from-amber-400/20 via-amber-500/10 to-yellow-600/[0.08] p-5 text-center">
      <div className="pointer-events-none absolute inset-0 opacity-60">
        {Array.from({ length: 24 }).map((_, i) => (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${(i * 4.1) % 100}%`,
              animationDelay: `${(i % 8) * 0.25}s`,
              background: ['#FCD34D', '#FBBF24', '#F59E0B', '#FDE68A'][i % 4],
            }}
          />
        ))}
      </div>
      <p className="relative text-xs font-medium uppercase tracking-wide text-amber-200">🏆 এই সপ্তাহের সেরা পারফর্মার</p>
      <p className="relative mt-1 text-2xl font-bold text-white">🎉 {name} 🎉</p>
      <p className="relative mt-1 text-sm text-amber-100/90">অভিনন্দন! পুরো সপ্তাহ জুড়ে আপনার নাম সবার অফিসে দেখা যাবে।</p>
      <style>{`
        .confetti-piece{position:absolute;top:-10px;width:7px;height:12px;border-radius:1px;animation:office-confetti 2.6s linear infinite}
        @keyframes office-confetti{0%{transform:translateY(-10px) rotate(0)}100%{transform:translateY(160px) rotate(360deg)}}
      `}</style>
    </div>
  )
}

function fmt(secondsLeft: number): { text: string; danger: boolean } {
  if (secondsLeft <= 0) return { text: 'সময় শেষ — বসকে জানানো হবে', danger: true }
  const m = Math.floor(secondsLeft / 60)
  const s = secondsLeft % 60
  return { text: `${m}:${String(s).padStart(2, '0')} এর মধ্যে দিন`, danger: secondsLeft < 120 }
}

function UpdateAlert({ t, busy, onSend }: { t: StaffTaskCard; busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [left, setLeft] = useState(t.updateSecondsLeft)
  const [text, setText] = useState('')
  useEffect(() => {
    setLeft(t.updateSecondsLeft)
    const id = setInterval(() => setLeft((v) => v - 1), 1000)
    return () => clearInterval(id)
  }, [t.updateSecondsLeft])
  const cd = fmt(left)
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] p-3">
      <p className="text-sm font-medium text-rose-100">⏰ আপডেট চাওয়া হয়েছে: {t.title}</p>
      {t.updateNote && <p className="mt-0.5 text-xs text-slate-300">“{t.updateNote}”</p>}
      <p className={`mt-1 text-xs font-medium ${cd.danger ? 'text-rose-300' : 'text-amber-300'}`}>⏳ {cd.text}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="অবস্থা লিখুন…"
          className="flex-1 rounded-md bg-black/30 px-2 py-1.5 text-sm text-slate-100 outline-none ring-1 ring-white/10"
        />
        <button
          disabled={busy || !text.trim()}
          onClick={async () => { if (await onSend(text.trim())) setText('') }}
          className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/30 disabled:opacity-50"
        >
          দিন
        </button>
      </div>
    </div>
  )
}

const VS_LABEL: Record<string, { label: string; tone: string }> = {
  redo_requested: { label: 'সংশোধন দরকার', tone: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  proof_submitted: { label: 'প্রমাণ জমা — যাচাই চলছে', tone: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  awaiting_proof: { label: 'প্রমাণ দিন', tone: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' },
  owner_approved: { label: 'অনুমোদিত', tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
}

function StaffTaskCardView({
  t,
  open,
  busy,
  onToggle,
  onDone,
  onProof,
  onComment,
}: {
  t: StaffTaskCard
  open: boolean
  busy: boolean
  onToggle: () => void
  onDone: () => void
  onProof: (url: string | undefined, text: string | undefined) => Promise<boolean>
  onComment: (text: string) => void
}) {
  const meta = VS_LABEL[t.verificationStatus]
  const isRedo = t.verificationStatus === 'redo_requested'

  return (
    <article className={`rounded-2xl border p-4 ${isRedo ? 'border-amber-500/30 bg-amber-500/[0.05]' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium leading-snug text-white">
          {t.needsUpdate ? '🔔 ' : ''}{t.title}
        </h3>
        {meta && <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${meta.tone}`}>{meta.label}</span>}
      </div>

      {t.friendlyDetail && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-medium text-slate-400">🧠 কাজটি যেভাবে করবেন</p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-slate-300">{t.friendlyDetail}</p>
        </div>
      )}

      {isRedo && t.reviewerNote && (
        <div className="mt-2 rounded-lg bg-amber-500/10 p-2">
          <p className="text-xs font-medium text-amber-300">🔄 মালিক যা সংশোধন চেয়েছেন:</p>
          <p className="text-sm text-amber-100">{t.reviewerNote}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {t.status !== 'done' && (
          <button
            disabled={busy}
            onClick={onDone}
            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/30 disabled:opacity-50"
          >
            ✅ সম্পন্ন
          </button>
        )}
        <ProofButton busy={busy} onProof={onProof} />
        <button
          disabled={busy}
          onClick={onToggle}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 disabled:opacity-50"
        >
          💬 থ্রেড {open ? '▲' : '▼'}
        </button>
      </div>

      {open && <StaffThread taskId={t.id} busy={busy} onComment={onComment} />}
    </article>
  )
}

function ProofButton({
  busy,
  onProof,
}: {
  busy: boolean
  onProof: (url: string | undefined, text: string | undefined) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileUrl = useRef<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)

  if (!editing) {
    return (
      <button
        disabled={busy}
        onClick={() => setEditing(true)}
        className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-200 ring-1 ring-sky-500/30 disabled:opacity-50"
      >
        📷 প্রমাণ পাঠান
      </button>
    )
  }

  const onPick = async (f: File | null) => {
    if (!f) return
    setUploading(true)
    setPreview(URL.createObjectURL(f))
    const url = await uploadProof(f)
    fileUrl.current = url ?? undefined
    setUploading(false)
    if (!url) setPreview(null)
  }

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg bg-white/5 p-2 ring-1 ring-white/10">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-white/10 px-3 py-1 text-sm text-slate-200 ring-1 ring-white/10"
        >
          🖼️ ছবি নির্বাচন
        </button>
        {uploading && <span className="text-xs text-slate-400">আপলোড হচ্ছে…</span>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && !uploading && <img src={preview} alt="preview" className="h-10 w-10 rounded object-cover" />}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="ছবি বা লেখা — যেকোনো একটি প্রমাণ দিন…"
        className="w-full resize-none rounded-md bg-black/20 p-2 text-sm text-slate-100 outline-none ring-1 ring-white/10"
      />
      <div className="flex gap-2">
        <button
          disabled={busy || uploading || (!fileUrl.current && !text.trim())}
          onClick={async () => {
            const ok = await onProof(fileUrl.current, text.trim() || undefined)
            if (ok) { setEditing(false); setText(''); setPreview(null); fileUrl.current = undefined }
          }}
          className="rounded-md bg-sky-500/20 px-3 py-1 text-sm font-medium text-sky-200 ring-1 ring-sky-500/30 disabled:opacity-50"
        >
          পাঠান
        </button>
        <button
          onClick={() => { setEditing(false); setText(''); setPreview(null); fileUrl.current = undefined }}
          className="rounded-md bg-white/5 px-3 py-1 text-sm text-slate-300 ring-1 ring-white/10"
        >
          বাতিল
        </button>
      </div>
    </div>
  )
}

function StaffThread({ taskId, busy, onComment }: { taskId: string; busy: boolean; onComment: (text: string) => void }) {
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const reqId = useRef(0)

  useEffect(() => {
    const my = ++reqId.current
    setLoading(true)
    fetch(`/api/assistant/office/thread?taskId=${encodeURIComponent(taskId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaskThread | null) => { if (my === reqId.current) setThread(d) })
      .finally(() => { if (my === reqId.current) setLoading(false) })
  }, [taskId, busy])

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
      {loading && <p className="text-xs text-slate-500">লোড হচ্ছে…</p>}
      {!loading && thread && (
        <>
          {thread.comments.length === 0 && <p className="text-xs text-slate-500">এখনো কোনো মন্তব্য নেই।</p>}
          <div className="space-y-2">
            {thread.comments.map((c) => <Bubble key={c.id} c={c} />)}
          </div>
        </>
      )}
      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="মালিককে কিছু লিখুন…"
          className="flex-1 rounded-md bg-black/30 px-2 py-1.5 text-sm text-slate-100 outline-none ring-1 ring-white/10"
        />
        <button
          disabled={busy || !draft.trim()}
          onClick={() => { onComment(draft.trim()); setDraft('') }}
          className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/30 disabled:opacity-50"
        >
          পাঠান
        </button>
      </div>
    </div>
  )
}

function Bubble({ c }: { c: ThreadMessage }) {
  const isOwner = c.authorType === 'owner'
  const isAgent = c.authorType === 'agent'
  const who = isOwner ? '👑 মালিক' : isAgent ? '🤖 এজেন্ট' : '👤 আপনি'
  const tone = isOwner ? 'bg-emerald-500/10 text-emerald-100' : isAgent ? 'bg-violet-500/10 text-violet-100' : 'bg-white/5 text-slate-200'
  return (
    <div className={`rounded-lg p-2 ${tone}`}>
      <p className="mb-0.5 text-xs opacity-70">{who}{c.kind === 'revision_request' ? ' · সংশোধন' : ''}</p>
      <p className="whitespace-pre-line text-sm">{c.body}</p>
    </div>
  )
}

function SelfInitiated({
  proposals,
  busy,
  onCreate,
}: {
  proposals: StaffTaskCard[]
  busy: boolean
  onCreate: (title: string, detail: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')

  return (
    <section className="rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">✨ নিজ উদ্যোগে কাজ</h2>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg bg-violet-500/20 px-3 py-1 text-sm font-medium text-violet-200 ring-1 ring-violet-500/30"
        >
          {open ? 'বন্ধ' : '+ নতুন'}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-400">নিজে কোনো কাজ করতে চাইলে এখানে দিন — মালিক অনুমোদন দিলে পারফরম্যান্সে যোগ হবে।</p>

      {open && (
        <div className="mt-3 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="কাজের শিরোনাম"
            className="w-full rounded-md bg-black/30 px-2 py-1.5 text-sm text-slate-100 outline-none ring-1 ring-white/10"
          />
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            placeholder="বিস্তারিত (ঐচ্ছিক)"
            className="w-full resize-none rounded-md bg-black/30 p-2 text-sm text-slate-100 outline-none ring-1 ring-white/10"
          />
          <button
            disabled={busy || !title.trim()}
            onClick={async () => { if (await onCreate(title.trim(), detail.trim())) { setTitle(''); setDetail(''); setOpen(false) } }}
            className="rounded-md bg-violet-500/20 px-3 py-1.5 text-sm font-medium text-violet-200 ring-1 ring-violet-500/30 disabled:opacity-50"
          >
            পাঠান
          </button>
        </div>
      )}

      {proposals.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded-lg bg-white/5 px-2.5 py-1.5 text-sm">
              <span className="min-w-0 truncate text-slate-200">{p.title}</span>
              <span className="shrink-0 text-xs text-amber-300">অপেক্ষমাণ</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

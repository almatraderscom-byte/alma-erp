'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type {
  OwnerHubData,
  HubTaskCard,
  HubAward,
  OverdueUpdateCard,
  TaskThread,
  ThreadMessage,
  ActivityItem,
} from '@/agent/lib/office-hub'

type ActionBody = {
  action: 'approve' | 'redo' | 'comment' | 'request_update' | 'self_approve' | 'self_reject'
  taskId: string
  note?: string
  body?: string
  businessId?: string
}

async function postAction(body: ActionBody): Promise<boolean> {
  const res = await fetch('/api/assistant/office/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

export default function OwnerHub({ data }: { data: OwnerHubData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, body: ActionBody) => {
      setBusyId(key)
      const ok = await postAction({ ...body, businessId: data.businessId })
      setBusyId(null)
      if (ok) startTransition(() => router.refresh())
      return ok
    },
    [data.businessId, router],
  )

  const { kpis, award, overdueUpdates, pendingApproval, selfInitiated, activity } = data
  const busy = pending || busyId !== null

  return (
    <div className="space-y-6">
      <AwardManager award={award} businessId={data.businessId} />

      {/* KPIs */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="অনুমোদনের অপেক্ষায়" value={kpis.pending} tone="text-amber-300" />
        <Kpi label="আজ চলমান" value={kpis.active} tone="text-sky-300" />
        <Kpi label="আপডেট বাকি" value={kpis.overdue} tone="text-rose-300" />
        <Kpi label="আজ সম্পন্ন" value={kpis.doneToday} tone="text-emerald-300" />
      </section>

      {/* Update tracking */}
      {overdueUpdates.length > 0 && (
        <section>
          <SectionHead icon="⏰" title="আপডেট চাওয়া হয়েছে — এখনো দেয়নি" />
          <div className="space-y-2">
            {overdueUpdates.map((u) => (
              <OverdueRow
                key={u.id}
                u={u}
                busy={busy}
                onRemind={() => run(`remind-${u.id}`, { action: 'request_update', taskId: u.id, note: u.note ?? undefined })}
              />
            ))}
          </div>
        </section>
      )}

      {/* Self-initiated */}
      {selfInitiated.length > 0 && (
        <section>
          <SectionHead icon="✨" title="নিজ উদ্যোগের কাজ — অনুমোদন দিন" />
          <div className="space-y-2">
            {selfInitiated.map((t) => (
              <article key={t.id} className="rounded-2xl border border-violet-500/25 bg-violet-500/[0.06] p-4">
                <p className="text-xs text-violet-300">✨ {t.staffName} — নিজ উদ্যোগে</p>
                <h3 className="mt-0.5 text-base font-medium text-white">{t.title}</h3>
                {t.detail && <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{t.detail}</p>}
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => run(`self-ok-${t.id}`, { action: 'self_approve', taskId: t.id })}
                    className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/30 disabled:opacity-50"
                  >
                    ✅ অনুমোদন
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(`self-no-${t.id}`, { action: 'self_reject', taskId: t.id })}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 disabled:opacity-50"
                  >
                    বাতিল
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Pending approval */}
      <section>
        <SectionHead icon="🔍" title={`অনুমোদনের অপেক্ষায় (${pendingApproval.length})`} />
        {pendingApproval.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-slate-400">
            এখন অনুমোদনের অপেক্ষায় কোনো কাজ নেই।
          </p>
        ) : (
          <div className="space-y-3">
            {pendingApproval.map((t) => (
              <ApprovalCard
                key={t.id}
                task={t}
                open={openTaskId === t.id}
                busy={busy}
                onToggle={() => setOpenTaskId(openTaskId === t.id ? null : t.id)}
                businessId={data.businessId}
                onApprove={() => run(`ok-${t.id}`, { action: 'approve', taskId: t.id })}
                onRedo={(note) => run(`redo-${t.id}`, { action: 'redo', taskId: t.id, note })}
                onComment={(body) => run(`cmt-${t.id}`, { action: 'comment', taskId: t.id, body })}
              />
            ))}
          </div>
        )}
      </section>

      {/* Activity feed */}
      {activity.length > 0 && (
        <section>
          <SectionHead icon="📜" title="সাম্প্রতিক কার্যক্রম" />
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <ul className="space-y-2">
              {activity.slice(0, 12).map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-center">
      <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
      <p className="mt-0.5 text-xs text-slate-400">{label}</p>
    </div>
  )
}

function SectionHead({ icon, title }: { icon: string; title: string }) {
  return (
    <h2 className="mb-2 text-base font-semibold text-white">
      {icon} {title}
    </h2>
  )
}

type AwardScore = { staffId: string; staffName: string; score: number; done: number }

function AwardManager({ award, businessId }: { award: HubAward; businessId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [scores, setScores] = useState<AwardScore[] | null>(null)
  const [busy, setBusy] = useState(false)

  const loadScores = useCallback(async () => {
    const res = await fetch(`/api/assistant/office/award?businessId=${encodeURIComponent(businessId)}`, { cache: 'no-store' })
    if (res.ok) {
      const data = (await res.json()) as { scores: AwardScore[] }
      setScores(data.scores)
    }
  }, [businessId])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && scores === null) await loadScores()
  }

  const act = async (body: { action: 'recompute' | 'pin' | 'clear'; staffId?: string }) => {
    setBusy(true)
    const res = await fetch('/api/assistant/office/award', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, businessId }),
    })
    setBusy(false)
    if (res.ok) {
      await loadScores()
      router.refresh()
    }
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/15 to-amber-600/[0.06] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-300">🏆 এই সপ্তাহের সেরা পারফর্মার</p>
          {award ? (
            <>
              <p className="mt-1 text-xl font-semibold text-white">{award.staffName}</p>
              <p className="mt-0.5 text-sm text-amber-200/80">
                স্কোর {award.score}
                {award.pinnedByOwner ? ' · মালিক নির্বাচিত' : ' · স্বয়ংক্রিয়'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-amber-200/80">এখনো কেউ নির্বাচিত হয়নি — হিসাব করুন।</p>
          )}
        </div>
        <button
          onClick={toggle}
          className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-amber-100 ring-1 ring-amber-500/30"
        >
          {open ? 'বন্ধ' : 'পরিচালনা'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3 border-t border-amber-500/20 pt-3">
          <div className="flex flex-wrap gap-2">
            <button
              disabled={busy}
              onClick={() => act({ action: 'recompute' })}
              className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-100 ring-1 ring-amber-500/30 disabled:opacity-50"
            >
              🔄 স্বয়ংক্রিয় হিসাব
            </button>
            {award?.pinnedByOwner && (
              <button
                disabled={busy}
                onClick={() => act({ action: 'clear' })}
                className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 disabled:opacity-50"
              >
                পিন সরান
              </button>
            )}
          </div>

          {scores === null ? (
            <p className="text-xs text-slate-400">লোড হচ্ছে…</p>
          ) : scores.length === 0 ? (
            <p className="text-xs text-slate-400">এই সপ্তাহে এখনো কোনো স্কোর নেই।</p>
          ) : (
            <ul className="space-y-1.5">
              {scores.map((s) => {
                const isWinner = award?.staffId === s.staffId
                return (
                  <li key={s.staffId} className="flex items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-1.5">
                    <span className="min-w-0 truncate text-sm text-slate-200">
                      {isWinner ? '🏆 ' : ''}
                      {s.staffName}
                      <span className="ml-1.5 text-xs text-slate-500">স্কোর {s.score} · {s.done} সম্পন্ন</span>
                    </span>
                    <button
                      disabled={busy || isWinner}
                      onClick={() => act({ action: 'pin', staffId: s.staffId })}
                      className="shrink-0 rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-200 ring-1 ring-amber-500/25 disabled:opacity-40"
                    >
                      {isWinner ? 'নির্বাচিত' : '📌 নির্বাচন'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function fmtCountdown(secondsLeft: number): { text: string; danger: boolean } {
  if (secondsLeft <= 0) return { text: 'সময় শেষ — বসকে জানানো হবে', danger: true }
  const m = Math.floor(secondsLeft / 60)
  const s = secondsLeft % 60
  return { text: `${m}:${String(s).padStart(2, '0')} বাকি`, danger: secondsLeft < 120 }
}

function OverdueRow({ u, busy, onRemind }: { u: OverdueUpdateCard; busy: boolean; onRemind: () => void }) {
  const [left, setLeft] = useState(u.secondsLeft)
  useEffect(() => {
    setLeft(u.secondsLeft)
    const id = setInterval(() => setLeft((v) => v - 1), 1000)
    return () => clearInterval(id)
  }, [u.secondsLeft])

  const cd = fmtCountdown(left)
  return (
    <div className="rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{u.title}</p>
          <p className="text-xs text-slate-400">{u.staffName}</p>
          {u.note && <p className="mt-1 text-xs text-slate-300">“{u.note}”</p>}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${cd.danger ? 'bg-rose-500/20 text-rose-200' : 'bg-amber-500/15 text-amber-200'}`}>
          {u.escalated ? '⚠️ বসকে জানানো হয়েছে' : `⏳ ${cd.text}`}
        </span>
      </div>
      <button
        disabled={busy}
        onClick={onRemind}
        className="mt-2 rounded-lg bg-white/5 px-3 py-1 text-xs font-medium text-slate-200 ring-1 ring-white/10 disabled:opacity-50"
      >
        🔔 আবার মনে করিয়ে দিন
      </button>
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  proof_submitted: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  auto_verified: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
  redo_requested: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  owner_approved: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
}

const STATUS_LABEL: Record<string, string> = {
  proof_submitted: 'প্রমাণ জমা',
  auto_verified: 'অটো-যাচাই',
  redo_requested: 'সংশোধন চাওয়া',
  owner_approved: 'অনুমোদিত',
}

function ApprovalCard({
  task,
  open,
  busy,
  onToggle,
  businessId,
  onApprove,
  onRedo,
  onComment,
}: {
  task: HubTaskCard
  open: boolean
  busy: boolean
  onToggle: () => void
  businessId: string
  onApprove: () => void
  onRedo: (note: string) => void
  onComment: (body: string) => void
}) {
  const tone = STATUS_TONE[task.verificationStatus] ?? 'bg-slate-500/15 text-slate-300 ring-slate-500/30'
  const label = STATUS_LABEL[task.verificationStatus] ?? task.verificationStatus
  const proofImg = pickProofImage(task.proofData)
  const proofText = pickProofText(task.proofData)

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-medium leading-snug text-white">{task.title}</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {task.staffName}
            {task.redoCount > 0 ? ` · ${task.redoCount} বার সংশোধন` : ''}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${tone}`}>{label}</span>
      </div>

      {proofImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={proofImg} alt="proof" className="mt-3 max-h-60 w-full rounded-xl object-cover" />
      )}
      {proofText && <p className="mt-2 rounded-lg bg-white/5 p-2 text-sm text-slate-300">{proofText}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={onApprove}
          className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-200 ring-1 ring-emerald-500/30 disabled:opacity-50"
        >
          ✅ অনুমোদন
        </button>
        <RedoButton busy={busy} onRedo={onRedo} />
        <button
          disabled={busy}
          onClick={onToggle}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 disabled:opacity-50"
        >
          💬 থ্রেড {open ? '▲' : '▼'}
        </button>
      </div>

      {open && <Thread taskId={task.id} businessId={businessId} busy={busy} onComment={onComment} />}
    </article>
  )
}

function RedoButton({ busy, onRedo }: { busy: boolean; onRedo: (note: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  if (!editing) {
    return (
      <button
        disabled={busy}
        onClick={() => setEditing(true)}
        className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-200 ring-1 ring-amber-500/30 disabled:opacity-50"
      >
        🔄 সংশোধন
      </button>
    )
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg bg-white/5 p-2 ring-1 ring-white/10">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="কী সংশোধন করতে হবে লিখুন…"
        className="w-full resize-none rounded-md bg-black/20 p-2 text-sm text-slate-100 outline-none ring-1 ring-white/10"
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !note.trim()}
          onClick={() => onRedo(note.trim())}
          className="rounded-md bg-amber-500/20 px-3 py-1 text-sm font-medium text-amber-200 ring-1 ring-amber-500/30 disabled:opacity-50"
        >
          পাঠান
        </button>
        <button
          onClick={() => { setEditing(false); setNote('') }}
          className="rounded-md bg-white/5 px-3 py-1 text-sm text-slate-300 ring-1 ring-white/10"
        >
          বাতিল
        </button>
      </div>
    </div>
  )
}

function Thread({
  taskId,
  businessId,
  busy,
  onComment,
}: {
  taskId: string
  businessId: string
  busy: boolean
  onComment: (body: string) => void
}) {
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const reqId = useRef(0)

  useEffect(() => {
    const my = ++reqId.current
    setLoading(true)
    fetch(`/api/assistant/office/thread?taskId=${encodeURIComponent(taskId)}&businessId=${encodeURIComponent(businessId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaskThread | null) => {
        if (my === reqId.current) setThread(d)
      })
      .finally(() => {
        if (my === reqId.current) setLoading(false)
      })
  }, [taskId, businessId, busy])

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
      {loading && <p className="text-xs text-slate-500">লোড হচ্ছে…</p>}
      {!loading && thread && (
        <>
          {thread.comments.length === 0 && thread.events.length === 0 && (
            <p className="text-xs text-slate-500">এখনো কোনো মন্তব্য নেই।</p>
          )}
          <div className="space-y-2">
            {thread.comments.map((c) => (
              <CommentBubble key={c.id} c={c} />
            ))}
          </div>
          {thread.events.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-white/10 pt-2">
              {thread.events.map((e) => (
                <li key={e.id} className="text-xs text-slate-500">
                  · {e.summary}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="মন্তব্য লিখুন…"
          className="flex-1 rounded-md bg-black/30 px-2 py-1.5 text-sm text-slate-100 outline-none ring-1 ring-white/10"
        />
        <button
          disabled={busy || !draft.trim()}
          onClick={() => { onComment(draft.trim()); setDraft('') }}
          className="rounded-md bg-sky-500/20 px-3 py-1.5 text-sm font-medium text-sky-200 ring-1 ring-sky-500/30 disabled:opacity-50"
        >
          পাঠান
        </button>
      </div>
    </div>
  )
}

function CommentBubble({ c }: { c: ThreadMessage }) {
  const isOwner = c.authorType === 'owner'
  const isAgent = c.authorType === 'agent'
  const who = isOwner ? '👑 মালিক' : isAgent ? '🤖 এজেন্ট' : '👤 স্টাফ'
  const tone = isOwner
    ? 'bg-emerald-500/10 text-emerald-100'
    : isAgent
      ? 'bg-violet-500/10 text-violet-100'
      : 'bg-white/5 text-slate-200'
  return (
    <div className={`rounded-lg p-2 ${tone}`}>
      <p className="mb-0.5 text-xs opacity-70">
        {who}
        {c.kind === 'revision_request' ? ' · সংশোধন' : ''}
      </p>
      <p className="whitespace-pre-line text-sm">{c.body}</p>
    </div>
  )
}

function ActivityRow({ a }: { a: ActivityItem }) {
  return (
    <li className="flex items-baseline gap-2 text-sm text-slate-300">
      <span className="text-slate-500">·</span>
      <span className="min-w-0 flex-1 truncate">{a.summary}</span>
    </li>
  )
}

function pickProofImage(data: Record<string, unknown> | null): string | null {
  if (!data) return null
  for (const k of ['imageUrl', 'image', 'photo', 'url', 'fileUrl']) {
    const v = data[k]
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v
  }
  return null
}

function pickProofText(data: Record<string, unknown> | null): string | null {
  if (!data) return null
  for (const k of ['text', 'note', 'caption', 'evidence', 'link']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

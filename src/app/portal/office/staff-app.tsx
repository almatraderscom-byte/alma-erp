'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { StaffOfficeData, StaffTaskCard, TaskThread } from '@/agent/lib/office-hub'
import type { Motivation } from '@/agent/lib/office-motivation'
import Confetti from './confetti'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}
function bnTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('bn-BD', {
      timeZone: 'Asia/Dhaka',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  } catch {
    return ''
  }
}
// Deadline label in Asia/Dhaka, e.g. "২৪ জুন, ৫:০০ PM".
function bnDue(iso: string): string {
  try {
    const d = new Date(iso)
    const date = d.toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' })
    const time = d.toLocaleTimeString('bn-BD', { timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit', hour12: true })
    return `${date}, ${time}`
  } catch {
    return ''
  }
}

type StaffActionBody = {
  action: 'done' | 'proof' | 'comment' | 'update' | 'self_create'
  taskId?: string
  body?: string
  text?: string
  imageUrl?: string
  title?: string
  detail?: string
}

async function postStaff(body: StaffActionBody): Promise<{ ok: boolean }> {
  const res = await fetch('/api/assistant/office/staff-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: res.ok }
}

async function uploadProof(file: File): Promise<string | null> {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/assistant/office/upload', { method: 'POST', body: fd })
  if (!res.ok) return null
  const data = (await res.json()) as { url?: string }
  return data.url ?? null
}

// ════════════════════════════════════════════════════════════════════════════

export default function StaffApp({
  data,
  headerDate,
  motivation,
}: {
  data: StaffOfficeData
  headerDate: string
  motivation: Motivation
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
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

  const detailTask = detailId ? data.active.find((t) => t.id === detailId) ?? data.done.find((t) => t.id === detailId) ?? null : null

  if (detailTask) {
    return (
      <div className="stage">
        <StaffDetail
          t={detailTask}
          staffName={data.staffName}
          busy={busy}
          onBack={() => setDetailId(null)}
          onDone={() => run(`done-${detailTask.id}`, { action: 'done', taskId: detailTask.id })}
          onProof={(url, text) => run(`proof-${detailTask.id}`, { action: 'proof', taskId: detailTask.id, imageUrl: url, text })}
          onComment={(text) => run(`cmt-${detailTask.id}`, { action: 'comment', taskId: detailTask.id, body: text })}
        />
      </div>
    )
  }

  const needUpdate = data.active.filter((t) => t.needsUpdate)
  const total = data.active.length + data.done.length
  const doneN = data.done.length
  const remaining = data.active.length

  return (
    <>
      {/* sticky performer + daily motivation hero (requests 3 & 4) */}
      <div className="staff-hero">
        <PerformerHero data={data} />
        <MotivationCard m={motivation} />
      </div>

      <div className="phead">
        <div>
          <div className="kicker">আমার অফিস · মোবাইল অ্যাপ</div>
          <h1>👷 আমার কাজ</h1>
          <p>কাজ দেখুন, রেজাল্ট জমা দিন, আর Boss-এর ফিডব্যাক সাথে সাথে পান।</p>
        </div>
        <LunchControl initial={data.lunch} />
      </div>

      <CheckInBanner att={data.attendance} />

      <div className="stage">
        <div className="staffapp">
          <div className="sscreen">
            <div className="stitle">আমার কাজ · {headerDate}</div>
            <div className="sh1">আসসালামু আলাইকুম, {data.staffName}</div>
            <div className="ssub">
              আজ {bn(total)}টি কাজ · {bn(doneN)}টি সম্পন্ন, {bn(remaining)}টি বাকি
            </div>

            {needUpdate.map((t) => (
              <UpdateAlert key={t.id} t={t} busy={busy} onSend={(text) => run(`upd-${t.id}`, { action: 'update', taskId: t.id, body: text })} />
            ))}

            {data.active.length === 0 && data.done.length === 0 && (
              <div className="stask" style={{ textAlign: 'center' }}>
                <div className="top">
                  <h4 style={{ width: '100%', textAlign: 'center' }}>আজ কোনো কাজ নেই</h4>
                </div>
                <div className="d" style={{ textAlign: 'center' }}>নতুন কাজ এলে এখানে দেখতে পাবেন।</div>
              </div>
            )}

            {data.active.map((t) => (
              <StaskCard key={t.id} t={t} onOpen={() => setDetailId(t.id)} />
            ))}

            <SelfInitiated
              proposals={data.proposals}
              busy={busy}
              onCreate={(title, detail) => run('self-create', { action: 'self_create', title, detail })}
            />

            {data.done.map((t) => (
              <div key={t.id} className="stask" style={{ opacity: 0.65 }} onClick={() => setDetailId(t.id)}>
                <div className="top">
                  <h4>{t.title}</h4>
                  <span className="badge b-done">সম্পন্ন ✓</span>
                </div>
                <div className="d">📦 {t.type} · Boss অনুমোদন করেছেন</div>
              </div>
            ))}

            <div className="stitle" style={{ marginTop: 22 }}>
              আমার পারফরম্যান্স
            </div>
            <div className="perf">
              <div className="pc">
                <div className="v num" style={{ color: '#6ee7b7' }}>
                  {bn(doneN)}
                </div>
                <div className="l">আজ সম্পন্ন</div>
              </div>
              <div className="pc">
                <div className="v num" style={{ color: '#7dd3fc' }}>
                  {bn(remaining)}
                </div>
                <div className="l">বাকি কাজ</div>
              </div>
              <div className="pc">
                <div className="v num" style={{ color: '#fcd34d' }}>
                  {bn(data.proposals.length)}
                </div>
                <div className="l">নিজ উদ্যোগে</div>
              </div>
            </div>
            <div className="bar">
              <i style={{ width: `${total > 0 ? Math.round((doneN / total) * 100) : 0}%` }}></i>
            </div>
          </div>
        </div>
      </div>

      <div className="note" style={{ maxWidth: 820, margin: '26px auto 0' }}>
        <span className="i">💡</span>
        <div>
          সব আলোচনা, ছবি ও অনুমোদন এখন Office Hub-এ। নতুন কাজ, কমেন্ট বা অনুমোদনের নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।
        </div>
      </div>
    </>
  )
}

// ── sticky performer hero (request 3) ───────────────────────────────────────
function PerformerHero({ data }: { data: StaffOfficeData }) {
  const award = data.award
  const winner = data.isWinner
  const img = award?.imageUrl ?? null
  const initial = (award?.staffName?.trim()[0] ?? data.staffName.trim()[0] ?? '?').toUpperCase()
  return (
    <div className={`award-mini hero${winner ? ' me' : ''}`}>
      {winner && <Confetti mini />}
      <div className="inner">
        <div className="crownwrap">
          <span className="crown" style={{ fontSize: 22, top: -12 }}>
            👑
          </span>
          {img ? (
            <div className="photo img" style={{ backgroundImage: `url(${img})` }} />
          ) : (
            <div className="photo">{initial}</div>
          )}
        </div>
        <div>
          <span className="tag">🏆 এই সপ্তাহের সেরা পারফরমার</span>
          {winner ? (
            <>
              <h3>আপনিই সেরা, মাশাআল্লাহ! 🎉</h3>
              <div className="sub">টিমের #১ · অভিনন্দন!</div>
            </>
          ) : award ? (
            <>
              <h3>{award.staffName}</h3>
              <div className="sub">নিজের সেরাটা দিন — পরের সপ্তাহে আপনিও হতে পারেন!</div>
            </>
          ) : (
            <>
              <h3>আজ সেরাটা দিন 💪</h3>
              <div className="sub">প্রতিটি কাজ আপনাকে #১ এর দিকে এগিয়ে নেবে।</div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── daily motivation card (request 4) ───────────────────────────────────────
function MotivationCard({ m }: { m: Motivation }) {
  return (
    <div className="motiv">
      <div className="motiv-glow" />
      <div className="motiv-tag">✨ আজকের অনুপ্রেরণা</div>
      <div className="motiv-quote">{m.text}</div>
      <div className="motiv-foot">— {m.tag}</div>
    </div>
  )
}

// ── check-in status banner — office "active" follows ERP attendance ─────────
function CheckInBanner({ att }: { att: StaffOfficeData['attendance'] }) {
  if (att.checkedIn) {
    return (
      <div className="checkin-banner in">
        <span className="ci-dot" />
        <span>
          ✅ আপনি অফিসে <b>সক্রিয়</b> · চেক-ইন {att.checkInLabel}
        </span>
        <span className="ci-tail">আজকের কাজ নিচে দেখুন — শেষ হলে ✅ দিন।</span>
      </div>
    )
  }
  if (att.checkedOut) {
    return (
      <div className="checkin-banner out">
        <span className="ci-dot" />
        <span>🏁 আজকের চেক-আউট সম্পন্ন। আগামীকাল আবার দেখা হবে, ইনশাআল্লাহ।</span>
      </div>
    )
  }
  return (
    <div className="checkin-banner off">
      <span className="ci-dot" />
      <span>
        ⏳ এখনো চেক-ইন করেননি — <Link href="/portal">চেক-ইন করুন</Link> তাহলে অফিসে সক্রিয় দেখাবে।
      </span>
    </div>
  )
}

// ── lunch control (request 6) — 45-min allowance ────────────────────────────
const LUNCH_LIMIT_SEC = 45 * 60
function LunchControl({ initial }: { initial: { active: boolean; startedAt: string | null } }) {
  const router = useRouter()
  const [active, setActive] = useState(initial.active)
  const [startedAt, setStartedAt] = useState<string | null>(initial.startedAt)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    setActive(initial.active)
    setStartedAt(initial.startedAt)
  }, [initial.active, initial.startedAt])

  useEffect(() => {
    if (!active || !startedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [active, startedAt])

  const toggle = async () => {
    setBusy(true)
    const action = active ? 'end' : 'start'
    const res = await fetch('/api/assistant/office/lunch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setBusy(false)
    if (!res.ok) return
    const d = (await res.json().catch(() => ({}))) as { startedAt?: string }
    if (action === 'start') {
      setActive(true)
      setStartedAt(d.startedAt ?? new Date().toISOString())
    } else {
      setActive(false)
      setStartedAt(null)
      setElapsed(0)
    }
    router.refresh()
  }

  if (!active) {
    return (
      <button className="lunch-btn" disabled={busy} onClick={toggle}>
        🍽️ লাঞ্চে যাচ্ছি
      </button>
    )
  }

  const remaining = LUNCH_LIMIT_SEC - elapsed
  const over = remaining <= 0
  const mm = Math.floor(Math.abs(remaining) / 60)
  const ss = Math.abs(remaining) % 60
  const clock = `${bn(mm)}:${bn(String(ss).padStart(2, '0'))}`
  return (
    <div className={`lunch-live${over ? ' over' : ''}`}>
      <span className="lunch-timer">🍽️ লাঞ্চ · {over ? `⚠️ ${clock} বেশি` : `${clock} বাকি`}</span>
      <button className="lunch-btn end" disabled={busy} onClick={toggle}>
        ফিরে এসেছি
      </button>
    </div>
  )
}

// ── update alert (`.alert`) ─────────────────────────────────────────────────
function fmt(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'সময় শেষ'
  const m = Math.floor(secondsLeft / 60)
  return `${bn(m)} মিনিট বাকি`
}

function UpdateAlert({ t, busy, onSend }: { t: StaffTaskCard; busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [left, setLeft] = useState(t.updateSecondsLeft)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => {
    setLeft(t.updateSecondsLeft)
    const id = setInterval(() => setLeft((v) => v - 1), 1000)
    return () => clearInterval(id)
  }, [t.updateSecondsLeft])

  return (
    <div className="alert">
      <div className="t">⚠️ কাজের আপডেট চাওয়া হয়েছে</div>
      <div className="d">
        &ldquo;{t.title}&rdquo; — Boss আপডেট চেয়েছেন। {t.updateNote ? t.updateNote : 'কাজের ছবি/আপডেট দিন।'}
      </div>
      <div className="cd">⏱ ১০ মিনিটের মধ্যে না দিলে Boss-কে জানানো হবে · {fmt(left)}</div>
      {!open ? (
        <button className="btn primary sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
          📤 এখনই আপডেট দিন
        </button>
      ) : (
        <div className="ibox" style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="অবস্থা লিখুন…"
            style={{ flex: 1, background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '8px 14px', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
          />
          <button
            className="btn primary sm"
            disabled={busy || !text.trim()}
            onClick={async () => {
              if (await onSend(text.trim())) {
                setText('')
                setOpen(false)
              }
            }}
          >
            দিন
          </button>
        </div>
      )}
    </div>
  )
}

// ── task card (`.stask`) ────────────────────────────────────────────────────
const STASK_BADGE: Record<string, { cls: string; label: string }> = {
  redo_requested: { cls: 'b-redo', label: 'সংশোধন' },
  proof_submitted: { cls: 'b-pending', label: 'অপেক্ষায়' },
  auto_verified: { cls: 'b-pending', label: 'অপেক্ষায়' },
  awaiting_proof: { cls: 'b-active', label: 'চলছে' },
  owner_approved: { cls: 'b-done', label: 'সম্পন্ন ✓' },
}

function StaskCard({ t, onOpen }: { t: StaffTaskCard; onOpen: () => void }) {
  const badge = STASK_BADGE[t.verificationStatus] ?? { cls: 'b-active', label: 'চলছে' }
  const statusText =
    t.verificationStatus === 'redo_requested'
      ? 'Boss সংশোধন চেয়েছেন'
      : t.verificationStatus === 'proof_submitted' || t.verificationStatus === 'auto_verified'
        ? 'জমা দেওয়া হয়েছে'
        : 'এখনো জমা দেননি'
  const overdue = Boolean(t.dueAt) && t.status !== 'done' && new Date(t.dueAt!).getTime() < Date.now()
  return (
    <div className={`stask${t.carriedOver ? ' carry' : ''}`} onClick={onOpen}>
      <div className="top">
        <h4>{t.title}</h4>
        {t.carriedOver && <span className="badge b-carry">↩ আগের কাজ</span>}
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        {overdue && <span className="badge b-overdue">⏰ সময় শেষ</span>}
      </div>
      <div className="d">
        📦 {t.type} · {statusText}
        {t.carriedOver && <span style={{ color: '#c4b5fd' }}> · আগের দিনের অসম্পূর্ণ কাজ — শেষ করুন</span>}
      </div>
      {t.dueAt && (
        <div className={`due-staff${overdue ? ' over' : ''}`}>
          ⏳ সময়সীমা: {bnDue(t.dueAt)}{overdue ? ' — সময় পেরিয়ে গেছে, দ্রুত শেষ করুন' : ' এর মধ্যে শেষ করুন'}
        </div>
      )}
      {t.needsUpdate && <div className="ntf">🔔 Boss আপডেট চেয়েছেন — দেখুন</div>}
      {t.verificationStatus === 'redo_requested' && t.reviewerNote && (
        <div className="ntf">🔄 {t.reviewerNote}</div>
      )}
    </div>
  )
}

// ── task detail / thread (phone-2) ──────────────────────────────────────────
function StaffDetail({
  t,
  staffName,
  busy,
  onBack,
  onDone,
  onProof,
  onComment,
}: {
  t: StaffTaskCard
  staffName: string
  busy: boolean
  onBack: () => void
  onDone: () => void
  onProof: (url: string | undefined, text: string | undefined) => Promise<boolean>
  onComment: (text: string) => void
}) {
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileUrl = useRef<string | undefined>(undefined)
  const camRef = useRef<HTMLInputElement>(null)
  const galRef = useRef<HTMLInputElement>(null)
  const reqId = useRef(0)

  useEffect(() => {
    const my = ++reqId.current
    setLoading(true)
    fetch(`/api/assistant/office/thread?taskId=${encodeURIComponent(t.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaskThread | null) => {
        if (my === reqId.current) setThread(d)
      })
      .finally(() => {
        if (my === reqId.current) setLoading(false)
      })
  }, [t.id, busy])

  const onPick = async (f: File | null) => {
    if (!f) return
    setUploading(true)
    setPreview(URL.createObjectURL(f))
    const url = await uploadProof(f)
    fileUrl.current = url ?? undefined
    setUploading(false)
    if (!url) setPreview(null)
  }

  const badge = STASK_BADGE[t.verificationStatus] ?? { cls: 'b-active', label: 'চলছে' }
  const isRedo = t.verificationStatus === 'redo_requested'

  return (
    <div className="staffapp">
      <div className="sscreen">
        <button className="backbtn" onClick={onBack}>
          ← আমার কাজ
        </button>
        <h4 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>{t.title}</h4>
        <div className="row" style={{ display: 'flex', gap: 8, margin: '10px 0 4px', flexWrap: 'wrap' }}>
          <span className={`badge ${badge.cls}`}>{isRedo ? '🔄 সংশোধন দরকার' : badge.label}</span>
          <span className="chip" style={{ fontSize: 11, padding: '5px 10px' }}>
            📦 {t.type}
          </span>
        </div>

        {t.friendlyDetail && (
          <div className="instr" style={{ margin: '14px 0' }}>
            <div className="h">🧠 কাজটি যেভাবে করবেন</div>
            <p>{t.friendlyDetail}</p>
          </div>
        )}

        {isRedo && t.reviewerNote && (
          <div className="instr" style={{ margin: '14px 0', borderColor: 'rgba(245,158,11,.3)' }}>
            <div className="h">🔄 Boss যা সংশোধন চেয়েছেন</div>
            <p>{t.reviewerNote}</p>
          </div>
        )}

        <div className="msgs" style={{ padding: 0 }}>
          {loading && <div className="sysline"><span>লোড হচ্ছে…</span></div>}
          {!loading && thread && thread.comments.length === 0 && (
            <div className="sysline"><span>এখনো কোনো মন্তব্য নেই</span></div>
          )}
          {!loading &&
            thread?.comments.map((c) => {
              const isOwner = c.authorType === 'owner'
              const isAgent = c.authorType === 'agent'
              const who = isOwner ? 'Boss' : isAgent ? 'Agent' : 'আপনি'
              const initial = isOwner ? 'M' : isAgent ? '🤖' : (staffName.trim()[0] || '?').toUpperCase()
              const avv = isOwner ? 'o' : isAgent ? 'gray' : 'e'
              return (
                <div key={c.id} className={`msg${isOwner ? ' owner' : ''}${isAgent ? ' agent' : ''}`}>
                  <span className={`av ${avv}`}>{initial}</span>
                  <div className="bubble">
                    <div className="mh">
                      <span className="nm">{who}</span>
                      <span className="tm">{bnTime(c.createdAt)}</span>
                    </div>
                    <div className="content" style={{ fontSize: 13 }}>
                      {c.body}
                    </div>
                  </div>
                </div>
              )
            })}
        </div>

        {/* submit result */}
        <div
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)',
            padding: 14,
            marginTop: 8,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>📎 রেজাল্ট জমা দিন</div>
          <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
          <input ref={galRef} type="file" accept="image/*" hidden onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => camRef.current?.click()}>
              📷 ছবি তুলুন
            </button>
            <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => galRef.current?.click()}>
              🖼️ গ্যালারি
            </button>
          </div>
          {uploading && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>আপলোড হচ্ছে…</div>}
          {preview && !uploading && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="preview" style={{ marginTop: 8, height: 64, borderRadius: 8, objectFit: 'cover' }} />
          )}
          <div
            className="ibox"
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              background: 'var(--bg-0)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-pill)',
              padding: '6px 6px 6px 14px',
              marginTop: 10,
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="কমেন্ট লিখুন…"
              style={{ flex: 1, background: 'transparent', border: 0, color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
            />
            <button
              className="btn primary sm"
              disabled={busy || uploading || (!fileUrl.current && !draft.trim())}
              onClick={async () => {
                if (fileUrl.current || draft.trim()) {
                  const ok = await onProof(fileUrl.current, draft.trim() || undefined)
                  if (ok) {
                    setDraft('')
                    setPreview(null)
                    fileUrl.current = undefined
                  }
                }
              }}
            >
              পাঠান
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            {t.status !== 'done' && (
              <button className="btn primary sm" disabled={busy} onClick={onDone} style={{ flex: 1, justifyContent: 'center' }}>
                ✅ সম্পন্ন হিসেবে চিহ্নিত করুন
              </button>
            )}
            <button
              className="btn sm"
              disabled={busy || !draft.trim()}
              onClick={() => {
                if (draft.trim()) {
                  onComment(draft.trim())
                  setDraft('')
                }
              }}
              style={{ flex: 1, justifyContent: 'center' }}
            >
              💬 শুধু কমেন্ট
            </button>
          </div>
        </div>

        <div className="note" style={{ marginTop: 14, fontSize: 12.5 }}>
          <span className="i">🔔</span>
          <div>
            Boss অনুমোদন দিলে কাজটি <b>সম্পন্ন</b> হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।
          </div>
        </div>
      </div>
    </div>
  )
}

// ── self-initiated (`.selfbtn` + dashed `.stask`) ───────────────────────────
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
    <>
      <button className="selfbtn" onClick={() => setOpen((v) => !v)}>
        ✨ নিজে থেকে একটা কাজ করেছি — জমা দিন
      </button>

      {open && (
        <div className="stask" style={{ borderStyle: 'dashed', borderColor: 'rgba(139,92,246,.4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="কাজের শিরোনাম"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm,10px)', padding: '8px 12px', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }}
            />
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={2}
              placeholder="বিস্তারিত (ঐচ্ছিক)"
              style={{ background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm,10px)', padding: '8px 12px', color: 'var(--ink)', fontFamily: 'inherit', fontSize: 13, outline: 'none', resize: 'none' }}
            />
            <button
              className="btn primary sm"
              disabled={busy || !title.trim()}
              onClick={async () => {
                if (await onCreate(title.trim(), detail.trim())) {
                  setTitle('')
                  setDetail('')
                  setOpen(false)
                }
              }}
              style={{ alignSelf: 'flex-start' }}
            >
              পাঠান
            </button>
          </div>
        </div>
      )}

      {proposals.map((p) => (
        <div key={p.id} className="stask" style={{ borderStyle: 'dashed', borderColor: 'rgba(139,92,246,.4)' }}>
          <div className="top">
            <h4>{p.title}</h4>
            <span className="self-badge">নিজ উদ্যোগে</span>
          </div>
          <div className="d">
            💡 অতিরিক্ত কাজ · <span style={{ color: '#fcd34d' }}>Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট</span>
          </div>
        </div>
      ))}
    </>
  )
}

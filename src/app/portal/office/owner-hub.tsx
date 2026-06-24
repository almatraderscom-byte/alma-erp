'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type {
  OwnerHubData,
  HubTaskCard,
  OverdueUpdateCard,
  TaskThread,
  ActivityItem,
  TeamMember,
  LeaderRow,
} from '@/agent/lib/office-hub'
import type { Motivation } from '@/agent/lib/office-motivation'
import Confetti from './confetti'

// ── small formatting helpers ────────────────────────────────────────────────
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
const AV_VARIANTS = ['e', 'm', 'gray'] as const
function avClass(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AV_VARIANTS[h % AV_VARIANTS.length]
}
const PH = ['ph1', 'ph2', 'ph3'] as const

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
function proofCount(data: Record<string, unknown> | null): number {
  if (!data) return 0
  for (const k of ['images', 'photos', 'attachments', 'files']) {
    const v = data[k]
    if (Array.isArray(v)) return v.length
  }
  return pickProofImage(data) ? 1 : 0
}
function pickQc(data: Record<string, unknown> | null): number | null {
  if (!data) return null
  for (const k of ['qcScore', 'qc', 'score', 'autoQc']) {
    const v = data[k]
    if (typeof v === 'number' && v >= 0 && v <= 100) return v
  }
  return null
}

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

// ════════════════════════════════════════════════════════════════════════════

export default function OwnerHub({
  data,
  headerDate,
  motivation,
}: {
  data: OwnerHubData
  headerDate: string
  motivation: Motivation
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [threadTask, setThreadTask] = useState<HubTaskCard | null>(null)
  const [awardOpen, setAwardOpen] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)

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

  const { kpis, award, awardStats, overdueUpdates, pendingApproval, activeTasks, selfInitiated, activity, team, leaderboard } = data
  const busy = pending || busyId !== null

  // staffId → profile image map (from team rows) for avatars across the hub
  const imgByStaff = new Map<string, string | null>(team.map((m) => [m.staffId, m.imageUrl]))

  // Group active tasks per staff so each staff member gets their own column.
  const activeByStaff = (() => {
    const groups = new Map<string, { staffId: string; staffName: string; tasks: HubTaskCard[] }>()
    for (const t of activeTasks) {
      let g = groups.get(t.staffId)
      if (!g) {
        g = { staffId: t.staffId, staffName: t.staffName, tasks: [] }
        groups.set(t.staffId, g)
      }
      g.tasks.push(t)
    }
    return [...groups.values()]
  })()

  // ── Thread detail swap (mirrors the demo's #owner-thread) ──
  if (threadTask) {
    return (
      <>
        <ThreadDetail
          task={threadTask}
          businessId={data.businessId}
          busy={busy}
          onZoom={setZoom}
          onBack={() => setThreadTask(null)}
          onApprove={async () => {
            const ok = await run(`ok-${threadTask.id}`, { action: 'approve', taskId: threadTask.id })
            if (ok) setThreadTask(null)
          }}
          onRedo={async (note) => {
            const ok = await run(`redo-${threadTask.id}`, { action: 'redo', taskId: threadTask.id, note })
            if (ok) setThreadTask(null)
          }}
          onComment={(body) => run(`cmt-${threadTask.id}`, { action: 'comment', taskId: threadTask.id, body })}
        />
        {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
      </>
    )
  }

  const winnerInitial = award ? (award.staffName.trim()[0] || '?').toUpperCase() : '?'

  return (
    <>
      {/* greeting */}
      <div className="phead">
        <div>
          <div className="kicker">অফিস হাব · {headerDate}</div>
          <h1>আসসালামু আলাইকুম, Boss 👋</h1>
          <p>আজকের অফিস এক নজরে — সব কাজ, সাবমিশন আর অনুমোদন এক জায়গায়।</p>
        </div>
        <div className="pill-row">
          <span className="chip live">
            <span className="dot"></span> {bn(kpis.online)} জন অনলাইন
          </span>
          <span className="chip">🔔 টেলিগ্রাম: শুধু নোটিফিকেশন</span>
        </div>
      </div>

      {/* Performer of the Week + daily motivation */}
      <div className="hero-row">
      <div className="award">
        <Confetti />
        <div className="ownerctl">
          <button className="btn ghost sm" onClick={() => setAwardOpen(true)}>
            ⚙️ ম্যানুয়াল নির্বাচন
          </button>
        </div>
        <div className="inner">
          <div className="crownwrap">
            <span className="crown">👑</span>
            {award?.imageUrl ? (
              <div className="photo img" style={{ backgroundImage: `url(${award.imageUrl})` }} />
            ) : (
              <div className="photo">{winnerInitial}</div>
            )}
          </div>
          <div className="meta">
            <span className="tag">🏆 এই সপ্তাহের সেরা পারফরমার</span>
            {award ? (
              <>
                <h2 className="aw">{award.staffName} — মাশাআল্লাহ!</h2>
                <div className="sub">পুরো টিমের মধ্যে সবচেয়ে বেশি কাজ ও সেরা মান। অভিনন্দন! 🎉</div>
                <div className="stats">
                  <div className="s">
                    <b>{bn(awardStats?.done ?? award.score)}</b>
                    <span>সম্পন্ন কাজ</span>
                  </div>
                  <div className="s">
                    <b>{awardStats?.approvalRate != null ? `${bn(awardStats.approvalRate)}%` : '—'}</b>
                    <span>অনুমোদন হার</span>
                  </div>
                  <div className="s">
                    <b>{awardStats?.avgQc != null ? bn(awardStats.avgQc) : '—'}</b>
                    <span>গড় QC স্কোর</span>
                  </div>
                  <div className="s">
                    <b>+{bn(awardStats?.selfInitiated ?? 0)}</b>
                    <span>নিজ উদ্যোগে</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h2 className="aw">এখনো নির্বাচিত হয়নি</h2>
                <div className="sub">এই সপ্তাহের সেরা পারফরমার নির্বাচন করতে &ldquo;ম্যানুয়াল নির্বাচন&rdquo;-এ ক্লিক করুন।</div>
              </>
            )}
          </div>
        </div>
      </div>
        <MotivationCard m={motivation} />
      </div>

      {/* KPIs */}
      <div className="kpis">
        <div className="kpi amber">
          <div className="glow"></div>
          <div className="ic">⏳</div>
          <div className="v num">{bn(kpis.pending)}</div>
          <div className="l">অনুমোদনের অপেক্ষায়</div>
        </div>
        <div className="kpi sky">
          <div className="glow"></div>
          <div className="ic">🔄</div>
          <div className="v num">{bn(kpis.active)}</div>
          <div className="l">চলমান কাজ</div>
        </div>
        <div className="kpi green">
          <div className="glow"></div>
          <div className="ic">✅</div>
          <div className="v num">{bn(kpis.doneToday)}</div>
          <div className="l">আজ সম্পন্ন</div>
        </div>
        <div className="kpi violet">
          <div className="glow"></div>
          <div className="ic">👥</div>
          <div className="v num">
            {bn(kpis.online)}/{bn(kpis.staffTotal)}
          </div>
          <div className="l">স্টাফ অনলাইন</div>
        </div>
      </div>

      {/* update tracking */}
      {overdueUpdates.length > 0 && (
        <div className="track">
          <div className="track-h">
            ⚠️ আপডেট ট্র্যাকিং — সাড়া পাওয়া যায়নি <span className="c">{bn(overdueUpdates.length)} জন</span>
          </div>
          {overdueUpdates.map((u) => (
            <OverdueRow
              key={u.id}
              u={u}
              busy={busy}
              onRemind={() => run(`remind-${u.id}`, { action: 'request_update', taskId: u.id, note: u.note ?? undefined })}
            />
          ))}
        </div>
      )}

      {/* main grid */}
      <div className="grid2">
        {/* LEFT: pending approvals + active tasks */}
        <div>
          <div className="section-h">
            <h2>⏳ অনুমোদনের অপেক্ষায়</h2>
            <span className="count">{bn(pendingApproval.length + selfInitiated.length)}টি</span>
          </div>
          <div className="card" style={{ marginBottom: 20 }}>
            {pendingApproval.length === 0 && selfInitiated.length === 0 && (
              <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>এখন অনুমোদনের অপেক্ষায় কোনো কাজ নেই।</div>
            )}
            {pendingApproval.map((t, i) => (
              <ApprovalRow
                key={t.id}
                task={t}
                idx={i}
                busy={busy}
                onOpen={() => setThreadTask(t)}
                onZoom={setZoom}
                onApprove={() => run(`ok-${t.id}`, { action: 'approve', taskId: t.id })}
                onRedo={() => setThreadTask(t)}
              />
            ))}
            {selfInitiated.map((t, i) => (
              <SelfRow
                key={t.id}
                task={t}
                idx={i}
                busy={busy}
                onOpen={() => setThreadTask(t)}
                onZoom={setZoom}
                onApprove={() => run(`self-ok-${t.id}`, { action: 'self_approve', taskId: t.id })}
              />
            ))}
          </div>

          <div className="section-h">
            <h2>🔄 চলমান কাজ</h2>
            <span className="count">{bn(activeTasks.length)}টি</span>
          </div>
          {activeByStaff.length === 0 ? (
            <div className="card">
              <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>এখন চলমান কোনো কাজ নেই।</div>
            </div>
          ) : (
            <div className="actcols">
              {activeByStaff.map((g) => {
                const img = imgByStaff.get(g.staffId) ?? null
                return (
                  <div className="actcol" key={g.staffId}>
                    <div className="actcol-h">
                      {img ? (
                        <span className={`av img`} style={{ backgroundImage: `url(${img})` }} />
                      ) : (
                        <span className={`av ${avClass(g.staffId)}`}>{(g.staffName.trim()[0] || '?').toUpperCase()}</span>
                      )}
                      <span className="nm">{g.staffName}</span>
                      <span className="count">{bn(g.tasks.length)}টি</span>
                    </div>
                    <div className="card">
                      {g.tasks.map((t, i) => (
                        <ActiveRow key={t.id} task={t} idx={i} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* RIGHT: team status + activity + leaderboard */}
        <div>
          <div className="section-h">
            <h2>👥 টিম স্ট্যাটাস</h2>
          </div>
          <div className="card" style={{ marginBottom: 20 }}>
            {team.length === 0 && (
              <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>কোনো স্টাফ যুক্ত নেই।</div>
            )}
            {team.map((m) => (
              <TeamRow key={m.staffId} m={m} />
            ))}
          </div>

          <div className="section-h">
            <h2>📡 টিম অ্যাক্টিভিটি</h2>
          </div>
          <div className="card feed">
            {activity.length === 0 && (
              <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>আজ এখনো কোনো কার্যক্রম নেই।</div>
            )}
            {activity.slice(0, 8).map((a, i, arr) => (
              <ActivityEv key={a.id} a={a} last={i === arr.length - 1} />
            ))}
          </div>

          <div className="section-h" style={{ marginTop: 20 }}>
            <h2>🏆 সাপ্তাহিক পারফরম্যান্স</h2>
            <span className="count">auto</span>
          </div>
          <div className="card">
            {leaderboard.length === 0 && (
              <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>এই সপ্তাহে এখনো স্কোর নেই।</div>
            )}
            {leaderboard.map((r, i) => (
              <LeadRow key={r.staffId} r={r} rank={i + 1} top={i === 0} winnerId={award?.staffId} />
            ))}
            <div
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--muted)', flex: 1 }}>
                প্রতি শুক্রবার auto-নির্বাচন · আপনি চাইলে বদলাতে পারবেন
              </span>
              <button className="btn sm" onClick={() => setAwardOpen(true)}>
                ✋ আমি নির্বাচন করব
              </button>
            </div>
          </div>
        </div>
      </div>

      {awardOpen && (
        <AwardModal businessId={data.businessId} winnerId={award?.staffId ?? null} onClose={() => setAwardOpen(false)} />
      )}
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
    </>
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

// ── fullscreen image lightbox (request 2) ───────────────────────────────────
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ohub-lightbox" onClick={onClose}>
      <button className="ohub-lightbox-close" aria-label="বন্ধ" onClick={onClose}>
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="proof" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

// ── update-tracking row ─────────────────────────────────────────────────────
function fmtCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'সময় শেষ'
  const m = Math.floor(secondsLeft / 60)
  return `${bn(m)} মিনিট বাকি`
}

function OverdueRow({ u, busy, onRemind }: { u: OverdueUpdateCard; busy: boolean; onRemind: () => void }) {
  const [left, setLeft] = useState(u.secondsLeft)
  useEffect(() => {
    setLeft(u.secondsLeft)
    const id = setInterval(() => setLeft((v) => v - 1), 1000)
    return () => clearInterval(id)
  }, [u.secondsLeft])

  return (
    <div className="trow">
      <span className={`av lg ${avClass(u.staffId)}`}>{(u.staffName.trim()[0] || '?').toUpperCase()}</span>
      <div className="info">
        <div className="nm">{u.staffName}</div>
        <div className="meta">
          📋 &ldquo;{u.title}&rdquo;{u.note ? ` — ${u.note}` : ' — কাজের ছবি/আপডেট পাঠায়নি।'}
        </div>
        <div className="esc">
          {u.escalated ? '🔔 অটো-রিমাইন্ডার পাঠানো হয়েছে · অপেক্ষা করা হচ্ছে' : `⏱ ১০ মিনিটে আপনাকে জানানো হবে · ${fmtCountdown(left)}`}
        </div>
      </div>
      <div className="acts">
        {u.phone && (
          <a className="btn sm primary" href={`tel:${u.phone}`}>
            📞 কল
          </a>
        )}
        <button className="btn sm" disabled={busy} onClick={onRemind}>
          🔔 মনে করান
        </button>
      </div>
    </div>
  )
}

// ── approval / active / self rows (`.appr`) ─────────────────────────────────
function thumbProps(card: HubTaskCard, idx: number): { className: string; style?: React.CSSProperties } {
  const img = pickProofImage(card.proofData)
  if (img) {
    return { className: 'thumb', style: { backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center' } }
  }
  return { className: `thumb ${PH[idx % PH.length]}` }
}

function ApprovalRow({
  task,
  idx,
  busy,
  onOpen,
  onZoom,
  onApprove,
  onRedo,
}: {
  task: HubTaskCard
  idx: number
  busy: boolean
  onOpen: () => void
  onZoom: (src: string) => void
  onApprove: () => void
  onRedo: () => void
}) {
  const th = thumbProps(task, idx)
  const proofImg = pickProofImage(task.proofData)
  const qc = pickQc(task.proofData)
  const count = proofCount(task.proofData)
  const text = pickProofText(task.proofData)
  const meta = [
    count > 0 ? `📎 ${bn(count)}টি জমা` : task.verificationStatus === 'auto_verified' ? '🤖 অটো-যাচাই' : 'ম্যানুয়াল রিভিউ দরকার',
    bnTime(task.createdAt),
    qc != null ? `QC স্কোর ${bn(qc)}/১০০` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="appr" onClick={onOpen}>
      <div
        {...th}
        className={proofImg ? `${th.className} zoomable` : th.className}
        onClick={
          proofImg
            ? (e) => {
                e.stopPropagation()
                onZoom(proofImg)
              }
            : undefined
        }
      />
      <div className="body">
        <div className="top">
          <span className={`av ${avClass(task.staffId)}`}>{(task.staffName.trim()[0] || '?').toUpperCase()}</span>
          <span className="meta">
            {task.staffName} · {task.type}
          </span>
        </div>
        <h3>{task.title}</h3>
        <div className="meta">{text ? text : meta}</div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn primary sm" disabled={busy} onClick={onApprove}>
            ✅ অনুমোদন
          </button>
          <button className="btn danger sm" disabled={busy} onClick={onRedo}>
            🔄 সংশোধন চাই
          </button>
          <button className="btn ghost sm" onClick={onOpen}>
            থ্রেড খুলুন →
          </button>
        </div>
      </div>
    </div>
  )
}

function SelfRow({
  task,
  idx,
  busy,
  onOpen,
  onZoom,
  onApprove,
}: {
  task: HubTaskCard
  idx: number
  busy: boolean
  onOpen: () => void
  onZoom: (src: string) => void
  onApprove: () => void
}) {
  const th = thumbProps(task, idx)
  const proofImg = pickProofImage(task.proofData)
  return (
    <div className="appr" onClick={onOpen}>
      <div
        {...th}
        className={proofImg ? `${th.className} zoomable` : th.className}
        onClick={
          proofImg
            ? (e) => {
                e.stopPropagation()
                onZoom(proofImg)
              }
            : undefined
        }
      />
      <div className="body">
        <div className="top">
          <span className={`av ${avClass(task.staffId)}`}>{(task.staffName.trim()[0] || '?').toUpperCase()}</span>
          <span className="meta">{task.staffName}</span>
          <span className="self-badge">✨ নিজ উদ্যোগে</span>
        </div>
        <h3>{task.title}</h3>
        <div className="meta">💡 অতিরিক্ত কাজ · অনুমোদন দিলে ওর পারফরম্যান্সে +যোগ হবে</div>
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn primary sm" disabled={busy} onClick={onApprove}>
            ✅ অনুমোদন + পয়েন্ট দিন
          </button>
          <button className="btn ghost sm" onClick={onOpen}>
            থ্রেড খুলুন →
          </button>
        </div>
      </div>
    </div>
  )
}

function ActiveRow({ task, idx }: { task: HubTaskCard; idx: number }) {
  const carried = task.status === 'carried' || task.source === 'carry'
  return (
    <div className="appr" style={{ cursor: 'default' }}>
      <div className={`thumb ${PH[idx % PH.length]}`} style={{ opacity: 0.6 }} />
      <div className="body">
        <div className="top">
          <span className={`av ${avClass(task.staffId)}`}>{(task.staffName.trim()[0] || '?').toUpperCase()}</span>
          <span className="meta">
            {task.staffName} · {task.type}
          </span>
          <span className={`badge ${carried ? 'b-carry' : 'b-active'}`}>{carried ? 'গতকাল থেকে' : 'চলছে'}</span>
        </div>
        <h3>{task.title}</h3>
        <div className="meta">🕐 পাঠানো হয়েছে {bnTime(task.createdAt)} · এখনো জমা দেয়নি</div>
      </div>
    </div>
  )
}

// ── team status / activity / leaderboard ────────────────────────────────────
function TeamRow({ m }: { m: TeamMember }) {
  const dot = m.status === 'on' ? 'on' : m.status === 'lunch' ? 'lunch' : 'off'
  return (
    <div className="staff-row">
      {m.imageUrl ? (
        <span className="av lg img" style={{ backgroundImage: `url(${m.imageUrl})` }} />
      ) : (
        <span className={`av lg ${avClass(m.staffId)}`}>{m.initial}</span>
      )}
      <div className="info">
        <div className="name">
          {m.name} <span className={`dotmini ${dot}`}></span>
          {m.checkedIn && m.checkInLabel && <span className="chip-in">✅ {m.checkInLabel}</span>}
        </div>
        <div className="sub">{m.sub}</div>
      </div>
    </div>
  )
}

const KIND_ICON: Record<string, string> = {
  proof_submitted: '📤',
  proof: '📤',
  comment: '💬',
  approved: '✅',
  owner_approved: '✅',
  redo_requested: '🔄',
  self_created: '✨',
  task_created: '📝',
  update_requested: '🔔',
  lunch: '🍽️',
  done: '✅',
}

function ActivityEv({ a, last }: { a: ActivityItem; last: boolean }) {
  return (
    <div className="ev">
      <div className="tl">
        <div className="ic">{KIND_ICON[a.kind] ?? '•'}</div>
        {!last && <div className="line"></div>}
      </div>
      <div>
        <div className="txt">{a.summary}</div>
        <div className="t">{bnTime(a.createdAt)}</div>
      </div>
    </div>
  )
}

const BAR_COLORS = [
  undefined,
  'linear-gradient(90deg,#0ea5e9,#7dd3fc)',
  'linear-gradient(90deg,#64748b,#94a3b8)',
]

function LeadRow({ r, rank, top, winnerId }: { r: LeaderRow; rank: number; top: boolean; winnerId?: string }) {
  const barStyle: React.CSSProperties = { width: `${r.pct}%` }
  const c = BAR_COLORS[Math.min(rank - 1, BAR_COLORS.length - 1)]
  if (c) barStyle.background = c
  return (
    <div className={`lead${top ? ' top' : ''}`}>
      <div className="rank">{bn(rank)}</div>
      {r.imageUrl ? (
        <span className="av img" style={{ backgroundImage: `url(${r.imageUrl})` }} />
      ) : (
        <span className={`av ${avClass(r.staffId)}`}>{r.initial}</span>
      )}
      <div className="info">
        <div className="nm">
          {r.name} {winnerId === r.staffId && <span className="pick">⭐ সেরা</span>}
        </div>
        <div className="ln">
          <div className="bar">
            <i style={barStyle}></i>
          </div>
        </div>
      </div>
      <div className="score">{bn(r.score)}</div>
    </div>
  )
}

// ── owner thread detail (mirrors #owner-thread) ─────────────────────────────
const VS_BADGE: Record<string, { cls: string; label: string }> = {
  proof_submitted: { cls: 'b-pending', label: '⏳ অনুমোদনের অপেক্ষায়' },
  auto_verified: { cls: 'b-pending', label: '🤖 অটো-যাচাই হয়েছে' },
  redo_requested: { cls: 'b-redo', label: '🔄 সংশোধন চাওয়া হয়েছে' },
  owner_approved: { cls: 'b-done', label: '✅ অনুমোদিত' },
}

function ThreadDetail({
  task,
  businessId,
  busy,
  onBack,
  onZoom,
  onApprove,
  onRedo,
  onComment,
}: {
  task: HubTaskCard
  businessId: string
  busy: boolean
  onBack: () => void
  onZoom: (src: string) => void
  onApprove: () => void
  onRedo: (note: string) => void
  onComment: (body: string) => void
}) {
  const proofImg = pickProofImage(task.proofData)
  const [thread, setThread] = useState<TaskThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [redoMode, setRedoMode] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    const my = ++reqId.current
    setLoading(true)
    fetch(`/api/assistant/office/thread?taskId=${encodeURIComponent(task.id)}&businessId=${encodeURIComponent(businessId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaskThread | null) => {
        if (my === reqId.current) setThread(d)
      })
      .finally(() => {
        if (my === reqId.current) setLoading(false)
      })
  }, [task.id, businessId, busy])

  const badge = VS_BADGE[task.verificationStatus] ?? { cls: 'b-pending', label: task.verificationStatus }

  return (
    <div className="grid2">
      <div className="card">
        <div className="thread-head">
          <div className="crumb" onClick={onBack}>
            ← অনুমোদনের অপেক্ষায়
          </div>
          <h2>{task.title}</h2>
          <div className="row">
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
            <span className="chip">
              <span className={`av ${avClass(task.staffId)}`} style={{ width: 20, height: 20, fontSize: 10 }}>
                {(task.staffName.trim()[0] || '?').toUpperCase()}
              </span>{' '}
              {task.staffName}
            </span>
            <span className="chip">📦 {task.type}</span>
          </div>
        </div>

        {task.detail && (
          <div className="instr">
            <div className="h">🧠 কাজটি যেভাবে করবেন</div>
            <p>{task.detail}</p>
          </div>
        )}

        {proofImg && (
          <div className="proof-shot" onClick={() => onZoom(proofImg)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={proofImg} alt="জমা দেওয়া প্রমাণ" />
            <span className="proof-zoom">🔍 বড় করে দেখুন</span>
          </div>
        )}

        <div className="msgs">
          {loading && <div className="sysline"><span>লোড হচ্ছে…</span></div>}
          {!loading && thread && thread.comments.length === 0 && (
            <div className="sysline"><span>এখনো কোনো মন্তব্য নেই</span></div>
          )}
          {!loading &&
            thread?.comments.map((c) => {
              const isOwner = c.authorType === 'owner'
              const isAgent = c.authorType === 'agent'
              const who = isOwner ? 'আপনি (Boss)' : isAgent ? 'Agent' : task.staffName
              const initial = isOwner ? 'M' : isAgent ? '🤖' : (task.staffName.trim()[0] || '?').toUpperCase()
              const avv = isOwner ? 'o' : isAgent ? 'gray' : avClass(task.staffId)
              return (
                <div key={c.id} className={`msg${isOwner ? ' owner' : ''}${isAgent ? ' agent' : ''}`}>
                  <span className={`av ${avv}`}>{initial}</span>
                  <div className="bubble">
                    <div className="mh">
                      <span className="nm">{who}</span>
                      <span className="tm">{bnTime(c.createdAt)}</span>
                    </div>
                    <div className="content">{c.body}</div>
                  </div>
                </div>
              )
            })}
        </div>

        <div className="composer">
          <div className="owner-actions">
            <button className="btn primary" disabled={busy} onClick={onApprove}>
              ✅ অনুমোদন করুন (Completed)
            </button>
            <button className="btn danger" disabled={busy} onClick={() => setRedoMode((v) => !v)}>
              🔄 সংশোধন চাই
            </button>
          </div>
          <div className="ibox">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={redoMode ? 'কী সংশোধন করতে হবে লিখুন…' : 'কমেন্ট লিখুন… স্টাফ সাথে সাথে নোটিফিকেশন পাবে'}
            />
            <button
              className="btn primary sm"
              disabled={busy || !draft.trim()}
              onClick={() => {
                const t = draft.trim()
                if (!t) return
                if (redoMode) onRedo(t)
                else onComment(t)
                setDraft('')
              }}
            >
              পাঠান
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="section-h">
          <h2>🧾 টাস্ক টাইমলাইন</h2>
        </div>
        <div className="card feed">
          {!thread || thread.events.length === 0 ? (
            <div style={{ padding: 18, fontSize: 13.5, color: 'var(--muted)' }}>কোনো টাইমলাইন তথ্য নেই।</div>
          ) : (
            thread.events.map((e, i, arr) => (
              <div className="ev" key={e.id}>
                <div className="tl">
                  <div className="ic">{KIND_ICON[e.kind] ?? '•'}</div>
                  {i !== arr.length - 1 && <div className="line"></div>}
                </div>
                <div>
                  <div className="txt">{e.summary}</div>
                  <div className="t">{bnTime(e.createdAt)}</div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="note">
          <span className="i">🔔</span>
          <div>
            এই থ্রেডের প্রতিটি কমেন্ট {task.staffName}-র মোবাইল অ্যাপ <b>ও</b> টেলিগ্রামে সাথে সাথে পৌঁছায় — কিছু মিস হয় না।
          </div>
        </div>
      </div>
    </div>
  )
}

// ── award manual-selection modal ────────────────────────────────────────────
type AwardScore = { staffId: string; staffName: string; score: number; done: number }

function AwardModal({
  businessId,
  winnerId,
  onClose,
}: {
  businessId: string
  winnerId: string | null
  onClose: () => void
}) {
  const router = useRouter()
  const [scores, setScores] = useState<AwardScore[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/assistant/office/award?businessId=${encodeURIComponent(businessId)}`, { cache: 'no-store' })
    if (res.ok) {
      const d = (await res.json()) as { scores: AwardScore[] }
      setScores(d.scores)
    }
  }, [businessId])

  useEffect(() => {
    load()
  }, [load])

  const act = async (body: { action: 'recompute' | 'pin' | 'clear'; staffId?: string }) => {
    setBusy(true)
    const res = await fetch('/api/assistant/office/award', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, businessId }),
    })
    setBusy(false)
    if (res.ok) {
      await load()
      router.refresh()
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        backdropFilter: 'blur(3px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 90,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: 'min(440px,100%)', maxHeight: '80vh', overflowY: 'auto', padding: 18 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <h2 style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>🏆 সেরা পারফরমার নির্বাচন</h2>
          <button className="btn ghost sm" onClick={onClose}>
            বন্ধ
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={busy} onClick={() => act({ action: 'recompute' })}>
            🔄 স্বয়ংক্রিয় হিসাব
          </button>
          {winnerId && (
            <button className="btn ghost sm" disabled={busy} onClick={() => act({ action: 'clear' })}>
              পিন সরান
            </button>
          )}
        </div>
        {scores === null ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>লোড হচ্ছে…</p>
        ) : scores.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>এই সপ্তাহে এখনো কোনো স্কোর নেই।</p>
        ) : (
          scores.map((s) => {
            const isWinner = winnerId === s.staffId
            return (
              <div key={s.staffId} className="staff-row">
                <span className={`av lg ${avClass(s.staffId)}`}>{(s.staffName.trim()[0] || '?').toUpperCase()}</span>
                <div className="info">
                  <div className="name">
                    {isWinner ? '🏆 ' : ''}
                    {s.staffName}
                  </div>
                  <div className="sub">
                    স্কোর {bn(s.score)} · {bn(s.done)} সম্পন্ন
                  </div>
                </div>
                <button className="btn sm" disabled={busy || isWinner} onClick={() => act({ action: 'pin', staffId: s.staffId })}>
                  {isWinner ? 'নির্বাচিত' : '📌 নির্বাচন'}
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

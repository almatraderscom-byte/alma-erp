import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { buildStaffFriendlyDetail } from '@/agent/lib/staff-task-format'
import { getOfficeDailyRecord, type OfficeDailyRecord, type StaffRollup } from '@/agent/lib/office-record'

export const metadata = { title: 'আমার অফিস · ALMA' }
export const dynamic = 'force-dynamic'

/** Dhaka-local YYYY-MM-DD for "today". */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** Bangla long date for the header, e.g. "১৯ জুন". */
function dhakaHeaderDate(): string {
  return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' }).format(new Date())
}

/** Bangla short date for a YYYY-MM-DD key, e.g. "১৯ জুন" (UTC-anchored to keep the key stable). */
function bnShortDate(ymd: string): string {
  return new Intl.DateTimeFormat('bn-BD', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    new Date(`${ymd}T00:00:00Z`),
  )
}

type StatusMeta = { label: string; tone: string }

const STATUS_META: Record<string, StatusMeta> = {
  sent: { label: 'চলছে', tone: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  approved: { label: 'অনুমোদিত', tone: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  carried: { label: 'গতকাল থেকে', tone: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' },
  done: { label: 'সম্পন্ন', tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
}

// Staff may only ever see "dispatched" tasks — never "proposed" (owner hasn't
// approved) or "cancelled". Read-only view; no mutations here.
const VISIBLE_STATUSES = ['sent', 'approved', 'carried', 'done'] as const

export default async function StaffOfficePage() {
  // Kill switch — office surface follows the agent module.
  if (!isAgentEnabled()) redirect('/portal')

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')

  const owner = isSystemOwner(session)

  // Resolve the staff record linked to THIS user only. The task query is keyed
  // off the authenticated user id — a staff member can never see another's tasks.
  const staff = await prisma.agentStaff.findFirst({
    where: { userId: session.user.id, active: true },
    select: { id: true, name: true, businessId: true },
  })

  const today = dhakaToday()
  const headerDate = dhakaHeaderDate()

  const tasks = staff
    ? await prisma.agentStaffTask.findMany({
        where: { staffId: staff.id, proposedFor: new Date(today), status: { in: [...VISIBLE_STATUSES] } },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, detail: true, type: true, productRef: true, status: true },
      })
    : []

  const active = tasks.filter((t) => t.status !== 'done')
  const done = tasks.filter((t) => t.status === 'done')

  // The "daily record" board shows team completion counts (not task details), so
  // it is shown to every viewer. Scoped to the relevant business.
  const record = await getOfficeDailyRecord(staff?.businessId ?? 'ALMA_LIFESTYLE')

  return (
    <main className="mx-auto min-h-screen w-full max-w-xl px-4 pb-24 pt-6 text-slate-100">
      <header className="mb-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">আজকের অফিস · {headerDate}</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">{staff ? 'আমার কাজ' : 'অফিস'}</h1>
        {staff && (
          <p className="mt-1 text-sm text-slate-400">
            {staff.name} — আজ {active.length}টি কাজ{done.length > 0 ? `, ${done.length}টি সম্পন্ন` : ''}
          </p>
        )}
        {!staff && owner && <p className="mt-1 text-sm text-slate-400">👑 মালিকের ভিউ — পুরো টিমের হিসাব নিচে</p>}
      </header>

      {/* ── My tasks (staff only) ── */}
      {staff && tasks.length === 0 && (
        <EmptyCard title="আজ কোনো কাজ নেই" body="আজকের জন্য আপনাকে এখনো কোনো কাজ দেওয়া হয়নি। নতুন কাজ এলে এখানে দেখতে পাবেন।" />
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          {active.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </section>
      )}

      {done.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-slate-400">সম্পন্ন</h2>
          <div className="space-y-3 opacity-70">
            {done.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        </section>
      )}

      {!staff && !owner && (
        <EmptyCard
          title="আপনার অফিস এখনো সেট করা হয়নি"
          body="আপনার অ্যাকাউন্ট এখনো অফিসের সাথে যুক্ত হয়নি। অফিস থেকে যুক্ত করা হলে আপনার আজকের কাজ এখানে দেখাবে।"
        />
      )}

      {/* ── Daily record board (everyone) ── */}
      <DailyRecordBoard record={record} className={staff && tasks.length > 0 ? 'mt-8' : 'mt-4'} />

      <p className="mt-8 text-center text-xs text-slate-500">
        শুধু দেখার জন্য — কাজের ছবি/result আগের মতোই Telegram-এ।
      </p>
    </main>
  )
}

function TaskCard({
  task,
}: {
  task: { id: string; title: string; detail: string | null; type: string; productRef: string | null; status: string }
}) {
  const meta = STATUS_META[task.status] ?? { label: task.status, tone: 'bg-slate-500/15 text-slate-300 ring-slate-500/30' }
  const detail = buildStaffFriendlyDetail({
    title: task.title,
    type: task.type,
    productRef: task.productRef,
    detail: task.detail,
  })

  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-medium leading-snug text-white">{task.title}</h3>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${meta.tone}`}>{meta.label}</span>
      </div>
      {detail && <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-300">{detail}</p>}
    </article>
  )
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <p className="text-base font-medium text-white">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  )
}

function pct(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((done / total) * 100)
}

function DailyRecordBoard({ record, className = '' }: { record: OfficeDailyRecord; className?: string }) {
  if (!record.hasData) return null

  // Dates (recent first) that actually have at least one staff entry.
  const dayRows = record.weekDates
    .map((date) => ({
      date,
      entries: record.staff
        .map((s) => ({ name: s.name, day: s.days.find((d) => d.date === date) }))
        .filter((e): e is { name: string; day: NonNullable<typeof e.day> } => Boolean(e.day)),
    }))
    .filter((row) => row.entries.length > 0)

  return (
    <section className={className}>
      <h2 className="mb-1 text-lg font-semibold text-white">📊 দিনের হিসাব</h2>
      <p className="mb-3 text-xs text-slate-500">কে আজ কয়টা কাজ শেষ করল — প্রতিদিন জমা হয়, সাপ্তাহিক/মাসিক হিসাব নিচে।</p>

      {/* Weekly + monthly rollup per staff */}
      <div className="space-y-2">
        {record.staff.map((s) => (
          <StaffRollupRow key={s.staffId} s={s} />
        ))}
      </div>

      {/* Daily breakdown */}
      {dayRows.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-medium text-slate-400">দৈনিক</h3>
          <div className="space-y-3">
            {dayRows.map((row) => (
              <div key={row.date} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <p className="mb-1.5 text-sm font-medium text-slate-200">📅 {bnShortDate(row.date)}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {row.entries.map((e) => (
                    <span key={e.name} className="text-sm text-slate-300">
                      {e.name} <span className="font-medium text-white">{e.day.done}</span>
                      <span className="text-slate-500">/{e.day.total}</span>
                      {e.day.total > 0 && e.day.done >= e.day.total ? ' ✅' : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function StaffRollupRow({ s }: { s: StaffRollup }) {
  const week = pct(s.weekDone, s.weekTotal)
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-medium text-white">{s.name}</span>
        <span className="text-sm text-slate-300">
          এই সপ্তাহ <span className="font-semibold text-white">{s.weekDone}</span>
          <span className="text-slate-500">/{s.weekTotal}</span>
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-emerald-400/70" style={{ width: `${week}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-slate-500">
        এই মাস: <span className="text-slate-300">{s.monthDone}</span>/{s.monthTotal}
      </p>
    </div>
  )
}

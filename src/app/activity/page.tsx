'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Card, Empty, PageHeader, Skeleton } from '@/components/ui'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { cn } from '@/lib/utils'

type AuditSource = 'approval' | 'payment_method' | 'archive' | 'trading_telegram' | 'telegram_ops' | 'volume_target'
type AuditEntry = {
  id: string; at: string; source: AuditSource; action: string; actor: string; resource: string; detail?: string; businessId?: string | null
}
type Payload = { entries: AuditEntry[]; sources: Record<AuditSource, number> }

const SOURCE_META: Record<AuditSource, { label: string; icon: string; tone: string }> = {
  approval: { label: 'অনুমোদন', icon: '✅', tone: 'text-gold-lt' },
  payment_method: { label: 'পেমেন্ট', icon: '💳', tone: 'text-success' },
  archive: { label: 'আর্কাইভ', icon: '📦', tone: 'text-muted-hi' },
  trading_telegram: { label: 'ট্রেডিং TG', icon: '✉️', tone: 'text-muted-hi' },
  telegram_ops: { label: 'অপস', icon: '📡', tone: 'text-muted-hi' },
  volume_target: { label: 'টার্গেট', icon: '🎯', tone: 'text-muted-hi' },
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'এইমাত্র'
  if (m < 60) return `${m} মিনিট আগে`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ঘণ্টা আগে`
  const d = Math.round(h / 24)
  return `${d} দিন আগে`
}

function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const fadeUp = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.3 } } }

export default function ActivityPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<AuditSource | 'all'>('all')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await safeFetchJson<Payload>('/api/audit-timeline', { cache: 'no-store' })
    if (res.ok) { setData(res.data); setError(null) }
    else setError(res.error.message || 'লোড করা গেল না')
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])
  useRegisterMobileRefresh(load)

  const filtered = useMemo(
    () => (data?.entries ?? []).filter(e => filter === 'all' || e.source === filter),
    [data, filter],
  )

  // Group by Dhaka day for date dividers.
  const groups = useMemo(() => {
    const out: Array<{ day: string; items: AuditEntry[] }> = []
    for (const e of filtered) {
      const k = dayKey(e.at)
      const last = out[out.length - 1]
      if (last && last.day === k) last.items.push(e)
      else out.push({ day: k, items: [e] })
    }
    return out
  }, [filtered])

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24 pt-3 sm:px-4 sm:pb-10">
      <PageHeader
        title="Activity"
        subtitle="কে কখন কী করল — এক জায়গায়"
        actions={<Button variant="ghost" size="sm" onClick={() => void load()}>↻</Button>}
      />

      {loading && !data ? (
        <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : error ? (
        <Card className="p-6"><Empty title="লোড করা গেল না" desc={error} action={<Button variant="gold" size="sm" onClick={() => void load()}>আবার চেষ্টা</Button>} /></Card>
      ) : data ? (
        <>
          {/* Source filter chips */}
          <div className="mb-4 flex flex-wrap gap-1.5">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')} label="সব" count={data.entries.length} />
            {(Object.keys(SOURCE_META) as AuditSource[]).filter(s => data.sources[s] > 0).map(s => (
              <Chip key={s} active={filter === s} onClick={() => setFilter(s)} label={`${SOURCE_META[s].icon} ${SOURCE_META[s].label}`} count={data.sources[s]} />
            ))}
          </div>

          {filtered.length === 0 ? (
            <Card className="p-6"><Empty title="কিছু নেই" desc="এই ফিল্টারে কোনো কার্যকলাপ পাওয়া যায়নি।" /></Card>
          ) : (
            <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-5">
              {groups.map(g => (
                <div key={g.day}>
                  <p className="mb-2 px-1 text-[10px] font-black uppercase tracking-[0.16em] text-muted">{g.day}</p>
                  <div className="space-y-2">
                    {g.items.map(e => {
                      const meta = SOURCE_META[e.source]
                      return (
                        <motion.div key={e.id} variants={fadeUp}>
                          <Card className="flex items-start gap-3 p-3.5">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-bg-2 text-base">{meta.icon}</span>
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] leading-snug text-cream">
                                <span className="font-bold">{e.actor}</span>{' '}
                                <span className="text-muted-hi">{e.action}</span>
                              </p>
                              <p className={cn('mt-0.5 text-[11px] font-semibold', meta.tone)}>{e.resource}</p>
                              {e.detail && <p className="mt-1 text-[11px] leading-relaxed text-muted">{e.detail}</p>}
                            </div>
                            <span className="shrink-0 text-[10px] text-muted">{relTime(e.at)}</span>
                          </Card>
                        </motion.div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </motion.div>
          )}
        </>
      ) : null}
    </div>
  )
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-bold transition-all',
        active ? 'border-gold-dim/60 bg-gold/15 text-gold-lt' : 'border-border text-muted hover:text-muted-hi hover:border-zinc-600',
      )}
    >
      {label} <span className="opacity-60">{count}</span>
    </button>
  )
}

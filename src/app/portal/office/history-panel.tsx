'use client'

import { useEffect, useState } from 'react'
import type { ArchiveDay, ArchiveDaySummary } from '@/agent/lib/office-hub'

const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

/**
 * Day-end history. Every past day's board is reconstructed on demand from the
 * durable task records (same data the live board uses) — so "yesterday" looks
 * exactly like today's design, just read-only. Owner-only.
 */
export default function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState<ArchiveDaySummary[] | null>(null)
  const [day, setDay] = useState<ArchiveDay | null>(null)
  const [loadingDay, setLoadingDay] = useState(false)

  useEffect(() => {
    fetch('/api/assistant/office/history', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { days: [] }))
      .then((d: { days: ArchiveDaySummary[] }) => setDays(d.days ?? []))
      .catch(() => setDays([]))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (day) setDay(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [day, onClose])

  const openDay = async (date: string) => {
    setLoadingDay(true)
    try {
      const res = await fetch(`/api/assistant/office/history?date=${encodeURIComponent(date)}`, { cache: 'no-store' })
      if (res.ok) setDay((await res.json()) as ArchiveDay)
    } finally {
      setLoadingDay(false)
    }
  }

  return (
    <div className="ohub-hist-ov" onClick={onClose}>
      <div className="ohub-hist" onClick={(e) => e.stopPropagation()}>
        <div className="hh">
          {day && (
            <button className="back" onClick={() => setDay(null)}>
              ← সব দিন
            </button>
          )}
          <span className="hic">📅</span>
          <span className="ttl">
            <b>{day ? day.label : 'অফিস ইতিহাস'}</b>
            <span>{day ? 'সেই দিনের পুরো বোর্ড (রিড-অনলি)' : 'আগের দিনগুলোর কাজের রেকর্ড'}</span>
          </span>
          <button className="x" onClick={onClose} aria-label="বন্ধ করুন">
            ×
          </button>
        </div>

        <div className="hbody">
          {!day && days === null && <div className="hloading">লোড হচ্ছে…</div>}

          {!day && days && days.length === 0 && (
            <div className="hempty">এখনো কোনো ইতিহাস নেই। দিন শেষে আজকের বোর্ড এখানে জমা হবে।</div>
          )}

          {!day &&
            days &&
            days.map((d) => (
              <button key={d.date} className="hday" onClick={() => openDay(d.date)} disabled={loadingDay}>
                <span className="cal">🗓️</span>
                <span className="info">
                  <span className="dt">{d.label}</span>
                  <span className="sub">
                    {bn(d.total)}টি কাজ · {bn(d.done)}টি সম্পন্ন · {bn(d.approved)}টি অনুমোদিত · {bn(d.staffCount)} জন স্টাফ
                  </span>
                </span>
                <span className="arr">›</span>
              </button>
            ))}

          {day && <DayBoard day={day} />}
          {loadingDay && !day && <div className="hloading">দিনের বোর্ড লোড হচ্ছে…</div>}
        </div>
      </div>
    </div>
  )
}

const VS_BADGE: Record<string, { cls: string; label: string }> = {
  owner_approved: { cls: 'b-done', label: 'অনুমোদিত ✓' },
  redo_requested: { cls: 'b-redo', label: 'সংশোধন' },
  proof_submitted: { cls: 'b-pending', label: 'অপেক্ষায়' },
  auto_verified: { cls: 'b-pending', label: 'অপেক্ষায়' },
  awaiting_proof: { cls: 'b-active', label: 'চলছিল' },
}

function DayBoard({ day }: { day: ArchiveDay }) {
  const k = day.kpis
  return (
    <>
      <div className="hk">
        <div className="c">
          <div className="v num" style={{ color: '#7dd3fc' }}>{bn(k.total)}</div>
          <div className="l">মোট কাজ</div>
        </div>
        <div className="c">
          <div className="v num" style={{ color: '#6ee7b7' }}>{bn(k.done)}</div>
          <div className="l">সম্পন্ন</div>
        </div>
        <div className="c">
          <div className="v num" style={{ color: '#fcd34d' }}>{bn(k.approved)}</div>
          <div className="l">অনুমোদিত</div>
        </div>
        <div className="c">
          <div className="v num" style={{ color: '#c4b5fd' }}>{bn(k.selfInitiated)}</div>
          <div className="l">নিজ উদ্যোগে</div>
        </div>
      </div>

      {day.perStaff.length > 0 && (
        <>
          <div className="hsec">স্টাফ পারফরম্যান্স</div>
          <div className="card" style={{ borderRadius: 16, overflow: 'hidden' }}>
            {day.perStaff.map((s) => (
              <div key={s.staffId} className="hstaff">
                <span className="av e">{s.initial}</span>
                <span className="nm">{s.name}</span>
                <span className="ct">
                  {bn(s.done)}/{bn(s.total)} সম্পন্ন
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="hsec">সেই দিনের কাজ</div>
      {day.tasks.map((t) => {
        const badge = VS_BADGE[t.verificationStatus] ?? { cls: t.status === 'done' ? 'b-done' : 'b-active', label: t.status === 'done' ? 'সম্পন্ন ✓' : 'চলছিল' }
        return (
          <div key={t.id} className="htask">
            <div className="tp">
              <h4>{t.title}</h4>
              <span className={`badge ${badge.cls}`}>{badge.label}</span>
            </div>
            <div className="d">
              👤 {t.staffName} · 📦 {t.type}
              {t.source === 'staff_initiated' ? ' · নিজ উদ্যোগে' : ''}
            </div>
          </div>
        )
      })}
    </>
  )
}

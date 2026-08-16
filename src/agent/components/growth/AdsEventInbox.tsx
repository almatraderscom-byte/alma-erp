'use client'

/**
 * Meta সুপারিশ inbox — where an ads push finally lands.
 *
 * Before this, a Meta Ads notification was a dead end: the tap opened a chat
 * with no record behind it. Every push now carries `?rec=<id>`, this section
 * reads it, auto-opens that event, pulls Meta's real recommendation text from
 * the Graph API, and gives the owner two decisions that STOP the nagging —
 * "করা হয়েছে" or "দরকার নেই".
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

type AdObjectDetail = {
  objectId: string
  name?: string | null
  effectiveStatus?: string | null
  recommendations: Array<{
    code?: number | string
    title?: string
    message?: string
    importance?: string
    confidence?: string
    blameField?: string
  }>
  error?: string
}

type AdsEvent = {
  id: string
  field: string
  recommendationType: string | null
  adObjectIds: string[]
  metaMessage: string | null
  title: string
  message: string
  tier: number
  status: 'new' | 'seen' | 'actioned' | 'dismissed'
  detail: AdObjectDetail[] | null
  detailError: string | null
  notifyCount: number
  lastSeenAt: string
  resolvedNote: string | null
}

const LIST_URL = '/api/assistant/growth/ads-events'

const FIELD_LABEL: Record<string, string> = {
  ad_recommendations: 'সুপারিশ',
  creative_fatigue: 'ক্রিয়েটিভ ক্লান্তি',
  field_changed: 'স্ট্যাটাস বদল',
  with_issues_ad_objects: 'সমস্যা',
  subscriptions: 'থ্রেশহোল্ড',
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins} মিনিট আগে`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} ঘণ্টা আগে`
  return `${Math.round(hours / 24)} দিন আগে`
}

export default function AdsEventInbox() {
  const searchParams = useSearchParams()
  const focusId = searchParams?.get('rec') ?? null

  const [events, setEvents] = useState<AdsEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showResolved, setShowResolved] = useState(false)
  const [openId, setOpenId] = useState<string | null>(focusId)
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (resolved: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${LIST_URL}?status=${resolved ? 'all' : 'open'}&limit=30`, { cache: 'no-store' })
      const data = (await res.json()) as { events?: AdsEvent[]; error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setEvents(data.events ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'লোড হয়নি')
      setEvents(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(showResolved)
  }, [load, showResolved])

  /** Opening an event pulls Meta's real text — the webhook never fetches it. */
  const openEvent = useCallback(
    async (id: string, opts?: { refresh?: boolean }) => {
      const next = openId === id && !opts?.refresh ? null : id
      setOpenId(next)
      if (!next) return

      const current = events?.find((e) => e.id === id)
      if (current?.detail && !opts?.refresh) return

      setDetailLoading(id)
      try {
        const res = await fetch(`${LIST_URL}/${id}${opts?.refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
        const data = (await res.json()) as { event?: AdsEvent; error?: string }
        if (data.event) {
          setEvents((prev) => (prev ?? []).map((e) => (e.id === id ? { ...e, ...data.event! } : e)))
        }
      } catch {
        // The row itself is already on screen; a failed detail read is shown by
        // the empty-detail line rather than blanking the card.
      } finally {
        setDetailLoading(null)
      }
    },
    [events, openId],
  )

  // A push tap deep-links straight to one event — open it without a click.
  useEffect(() => {
    if (!focusId || !events?.length) return
    if (events.some((e) => e.id === focusId)) void openEvent(focusId)
    // Only on first arrival with a focus id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, events?.length])

  const decide = useCallback(async (id: string, status: 'actioned' | 'dismissed') => {
    setBusyId(id)
    try {
      const res = await fetch(`${LIST_URL}/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const data = (await res.json()) as { event?: AdsEvent; error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setEvents((prev) =>
        (prev ?? [])
          .map((e) => (e.id === id ? { ...e, ...data.event! } : e))
          .filter((e) => showResolved || (e.status !== 'actioned' && e.status !== 'dismissed')),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'আপডেট হয়নি')
    } finally {
      setBusyId(null)
    }
  }, [showResolved])

  const openCount = (events ?? []).filter((e) => e.status === 'new' || e.status === 'seen').length

  return (
    <div className="glass-panel rounded-2xl border border-border-subtle p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-cream">
          Meta সুপারিশ ও অ্যালার্ট{openCount > 0 ? ` (${openCount})` : ''}
        </p>
        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          className="rounded-lg border border-border-subtle px-2 py-1 text-[10px] font-semibold text-muted transition-colors hover:text-cream"
        >
          {showResolved ? 'শুধু বাকিগুলো' : 'সব দেখুন'}
        </button>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted">
        ফোনে যে Meta Ads নোটিফিকেশন আসে সেগুলো এখানে জমা থাকে। খুললে Meta আসলে কী বলছে তা দেখাবে —
        &ldquo;করা হয়েছে&rdquo; বা &ldquo;দরকার নেই&rdquo; চাপলে ওই সুপারিশ আর নোটিফিকেশন পাঠাবে না।
      </p>

      {loading && <p className="text-[12px] text-muted">লোড হচ্ছে…</p>}
      {error && !loading && <p className="text-[12px] text-amber-400">সমস্যা: {error}</p>}
      {!loading && !error && events?.length === 0 && (
        <p className="text-[12px] text-muted">
          {showResolved ? 'কোনো ইভেন্ট নেই।' : 'বাকি কোনো সুপারিশ নেই — সব দেখা হয়ে গেছে।'}
        </p>
      )}

      <div className="space-y-2">
        {(events ?? []).map((event) => {
          const isOpen = openId === event.id
          const resolved = event.status === 'actioned' || event.status === 'dismissed'
          const dot = resolved ? 'bg-emerald-400' : event.tier >= 2 ? 'bg-amber-400' : 'bg-sky-400'
          return (
            <div
              key={event.id}
              className={`rounded-xl bg-card/60 px-3 py-2.5 transition-colors ${
                focusId === event.id ? 'ring-1 ring-[#E07A5F]/60' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => void openEvent(event.id)}
                className="flex w-full items-start gap-2.5 text-left"
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-bold text-cream">{event.title}</span>
                    <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted">
                      {event.recommendationType || FIELD_LABEL[event.field] || event.field}
                    </span>
                    {resolved && (
                      <span className="rounded-md bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-400">
                        {event.status === 'actioned' ? 'করা হয়েছে' : 'দরকার নেই'}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{event.message}</p>
                  <p className="mt-0.5 text-[10px] text-muted/70">
                    {timeAgo(event.lastSeenAt)}
                    {event.notifyCount > 1 ? ` · ${event.notifyCount} বার নোটিফাই` : ''}
                  </p>
                </div>
                <span className="mt-0.5 text-[11px] text-muted">{isOpen ? '▾' : '▸'}</span>
              </button>

              {isOpen && (
                <div className="mt-2.5 space-y-2 border-t border-border-subtle pt-2.5">
                  {detailLoading === event.id && (
                    <p className="text-[11px] text-muted">Meta থেকে বিস্তারিত আনা হচ্ছে…</p>
                  )}

                  {event.metaMessage && (
                    <p className="text-[11px] leading-relaxed text-cream/80">
                      <span className="font-semibold text-muted">Meta-র বার্তা: </span>
                      {event.metaMessage}
                    </p>
                  )}

                  {detailLoading !== event.id &&
                    (event.detail ?? []).map((obj) => (
                      <div key={obj.objectId} className="rounded-lg bg-black/20 px-2.5 py-2">
                        <p className="text-[11px] font-semibold text-cream">
                          {obj.name || `অবজেক্ট ${obj.objectId}`}
                          {obj.effectiveStatus ? (
                            <span className="ml-1.5 text-[10px] font-normal text-muted">({obj.effectiveStatus})</span>
                          ) : null}
                        </p>
                        {obj.error ? (
                          <p className="mt-0.5 text-[10px] text-amber-400">Meta পড়া যায়নি: {obj.error}</p>
                        ) : obj.recommendations.length === 0 ? (
                          <p className="mt-0.5 text-[10px] text-muted">
                            Meta এখন এই অবজেক্টে কোনো খোলা সুপারিশ দেখাচ্ছে না — সম্ভবত মেয়াদ শেষ বা নিজে থেকেই মিটে গেছে।
                          </p>
                        ) : (
                          <ul className="mt-1 space-y-1.5">
                            {obj.recommendations.map((rec, i) => (
                              <li key={`${obj.objectId}-${rec.code ?? i}`} className="text-[11px] leading-relaxed">
                                {rec.title && <span className="font-semibold text-cream">{rec.title}: </span>}
                                <span className="text-muted">{rec.message ?? '—'}</span>
                                {(rec.importance || rec.blameField) && (
                                  <span className="ml-1 text-[9px] uppercase text-muted/70">
                                    [{[rec.importance, rec.blameField].filter(Boolean).join(' · ')}]
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}

                  {detailLoading !== event.id && !event.detail && event.detailError && (
                    <p className="text-[11px] text-amber-400">বিস্তারিত আনা যায়নি: {event.detailError}</p>
                  )}

                  {event.resolvedNote && (
                    <p className="text-[10px] text-muted">নোট: {event.resolvedNote}</p>
                  )}

                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {!resolved && (
                      <>
                        <button
                          type="button"
                          disabled={busyId === event.id}
                          onClick={() => void decide(event.id, 'actioned')}
                          className="rounded-lg bg-[#E07A5F]/15 px-2.5 py-1.5 text-[11px] font-semibold text-[#E07A5F] transition-colors hover:bg-[#E07A5F]/25 disabled:opacity-50"
                        >
                          করা হয়েছে
                        </button>
                        <button
                          type="button"
                          disabled={busyId === event.id}
                          onClick={() => void decide(event.id, 'dismissed')}
                          className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] font-semibold text-muted transition-colors hover:text-cream disabled:opacity-50"
                        >
                          দরকার নেই
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={detailLoading === event.id}
                      onClick={() => void openEvent(event.id, { refresh: true })}
                      className="rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] font-semibold text-muted transition-colors hover:text-cream disabled:opacity-50"
                    >
                      Meta থেকে আবার আনুন
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

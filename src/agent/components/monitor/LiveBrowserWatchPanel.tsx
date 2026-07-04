'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

/** Mirrors GET /api/assistant/live-browser/watch. */
interface WatchDevice {
  id: string
  name: string
  online: boolean
  lastSeenAt: string | null
}
interface WatchStep {
  id: string
  device: string
  action: string
  target: string
  status: 'queued' | 'delivered' | 'done' | 'failed' | string
  error: string | null
  at: string
  resolvedAt: string | null
}
interface WatchFeed {
  enabled: boolean
  devices: WatchDevice[]
  steps: WatchStep[]
  latestScreenshot: string | null
  latestScreenshotAt: string | null
}

const ACTION_BN: Record<string, string> = {
  navigate: '🌐 পেজ খুলছে',
  read_text: '📖 পড়ছে',
  read_dom: '👀 দেখছে',
  click: '🖱️ ক্লিক',
  type: '⌨️ লিখছে',
  press: '⏎ কী চাপছে',
  select_option: '🔽 অপশন বাছছে',
  hover: '🫳 হোভার',
  scroll: '↕️ স্ক্রল',
  scroll_to: '🎯 স্ক্রল',
  wait: '⏳ অপেক্ষা',
  screenshot: '📸 স্ক্রিনশট',
  go_back: '↩️ পিছনে',
  switch_tab: '🗂️ ট্যাব বদল',
  close_tab: '❌ ট্যাব বন্ধ',
  ping: '📡 পিং',
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  queued: { label: 'অপেক্ষায়', cls: 'border-sky-300/40 bg-sky-400/10 text-sky-300' },
  delivered: { label: 'চলছে…', cls: 'border-amber-300/40 bg-amber-400/10 text-amber-300' },
  done: { label: 'হয়েছে', cls: 'border-emerald-300/40 bg-emerald-400/10 text-emerald-300' },
  failed: { label: 'ব্যর্থ', cls: 'border-red-300/40 bg-red-400/10 text-red-300' },
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso))
  } catch {
    return ''
  }
}

/**
 * P1 live watch panel — the owner watches the agent drive his Chrome step by
 * step (audit feed + newest screenshot), from any device (responsive), with a
 * server-side STOP that kills the queue even if the Chrome tab is far away.
 */
export default function LiveBrowserWatchPanel() {
  const [feed, setFeed] = useState<WatchFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/live-browser/watch?limit=30')
      if (res.ok) setFeed((await res.json()) as WatchFeed)
    } catch {
      /* keep last feed */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 2.5s poll while the tab is visible — pause when hidden to save battery/data.
    const start = () => {
      if (!timer.current) timer.current = setInterval(() => void load(), 2500)
    }
    const stop = () => {
      if (timer.current) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop())
    document.addEventListener('visibilitychange', onVis)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [load])

  async function act(action: 'stop' | 'resume') {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/assistant/live-browser/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(action === 'stop' ? '⏹ থামিয়ে দিলাম — লাইভ ব্রাউজার বন্ধ' : '▶️ আবার চালু')
      await load()
    } catch (err) {
      toast.error(`ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const enabled = feed?.enabled === true
  const onlineCount = feed?.devices.filter((d) => d.online).length ?? 0
  const running = feed?.steps.some((s) => s.status === 'queued' || s.status === 'delivered') ?? false

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">🖥️</span>
          <h2 className="text-[15px] font-bold text-cream">লাইভ ব্রাউজার — সরাসরি দেখুন</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {running && (
              <span className="rounded-full border border-amber-300/40 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300">
                🤖 কাজ চলছে
              </span>
            )}
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                enabled
                  ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-300'
                  : 'border-border-subtle bg-white/[0.02] text-muted'
              }`}
            >
              {enabled ? `🟢 চালু · অনলাইন ${onlineCount}` : '🔴 বন্ধ'}
            </span>
          </div>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-muted">
          এজেন্ট আপনার Chrome-এ কী করছে — প্রতিটা ধাপ আর সর্বশেষ স্ক্রিনশট এখানে লাইভ দেখা যায়। লাল বোতামে সব সাথে সাথে থামে।
        </p>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-3">
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => act(enabled ? 'stop' : 'resume')}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
              enabled
                ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {enabled ? '⏹ সব থামাও' : '▶️ আবার চালু করো'}
          </button>
          {feed && feed.devices.length > 0 && (
            <span className="ml-auto text-[11px] text-muted">
              {feed.devices.map((d) => `${d.online ? '🟢' : '⚪️'} ${d.name}`).join(' · ')}
            </span>
          )}
        </div>

        {/* Latest screenshot */}
        {feed?.latestScreenshot && (
          <div className="border-t border-border-subtle px-4 py-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[11px] font-semibold text-cream">📸 সর্বশেষ স্ক্রিনশট</span>
              <span className="text-[10px] text-muted">{fmtTime(feed.latestScreenshotAt)}</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={feed.latestScreenshot}
              alt="এজেন্ট এখন যে পেজ দেখছে"
              className="w-full rounded-[12px] border border-border-subtle"
            />
          </div>
        )}

        {/* Step feed */}
        <div className="border-t border-border-subtle px-4 py-3">
          {loading ? (
            <p className="py-4 text-center text-[12px] text-muted">লোড হচ্ছে…</p>
          ) : !feed || feed.steps.length === 0 ? (
            <p className="py-4 text-center text-[12px] text-muted">
              এখনো কোনো ধাপ নেই। এজেন্টকে ব্রাউজারের কাজ দিলে এখানে লাইভ দেখা যাবে।
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {feed.steps.map((s) => {
                const badge = STATUS_BADGE[s.status] ?? STATUS_BADGE.queued
                return (
                  <li key={s.id} className="flex items-start gap-2.5 rounded-[12px] bg-white/[0.02] px-3 py-2">
                    <span className="mt-0.5 min-w-[86px] text-[11px] font-semibold text-cream">
                      {ACTION_BN[s.action] ?? s.action}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[12px] leading-relaxed text-muted">
                        {s.target || '—'}
                        {s.error ? <span className="text-red-300"> · {s.error.slice(0, 120)}</span> : null}
                      </p>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] ${badge.cls}`}>{badge.label}</span>
                    <span className="mt-0.5 text-[10px] tabular-nums text-muted">{fmtTime(s.at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

/** Mirrors the server shapes in src/agent/lib/heartbeat/. */
interface HeartbeatSettings {
  enabled: boolean
  autoArm: boolean
  dailyHeadWakeCap: number
  officeHoursOnly: boolean
}
interface HeartbeatPulse {
  pendingApprovals: number
  ownerEscalations: number
  openTodos: number
}
interface HeartbeatEntry {
  id: string
  at: string
  kind: 'idle' | 'active' | 'blocked' | 'error'
  pulse: HeartbeatPulse
  headWoke: boolean
  summary: string
  costUsd?: number
  conversationId?: string
}
interface HeartbeatFeed {
  settings: HeartbeatSettings
  wakesToday: number
  entries: HeartbeatEntry[]
}

const KIND_TAG: Record<HeartbeatEntry['kind'], string> = { idle: '🫧', active: '🤖', blocked: '📝', error: '⚠️' }
const KIND_LABEL: Record<HeartbeatEntry['kind'], string> = {
  idle: 'শান্ত',
  active: 'নিজে সামলেছে',
  blocked: 'অনুমোদন চেয়েছে',
  error: 'সমস্যা',
}

function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso))
  } catch {
    return ''
  }
}

/**
 * The owner-facing "idle heartbeat" panel: a live view of the autonomous head
 * waking on its own — on/off + test button + a timeline of recent ticks, so the
 * owner can watch what the agent does between his own messages.
 */
export default function HeartbeatPanel() {
  const [feed, setFeed] = useState<HeartbeatFeed | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/heartbeat?limit=20')
      if (res.ok) setFeed((await res.json()) as HeartbeatFeed)
    } catch {
      /* keep last feed */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: string, okMsg: string) {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/assistant/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as HeartbeatFeed & { testResult?: { summary?: string; headWoke?: boolean } }
      setFeed(data)
      if (action === 'test_now') {
        const r = data.testResult
        toast.success(r?.summary ? `টেস্ট: ${r.summary.slice(0, 80)}` : okMsg)
      } else {
        toast.success(okMsg)
      }
    } catch (err) {
      toast.error(`ব্যর্থ: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const enabled = feed?.settings.enabled === true
  const autoArm = feed?.settings.autoArm === true

  return (
    <div className="safe-x mx-auto w-full max-w-5xl px-4 pt-4 md:px-6">
      <div className="alma-frost overflow-hidden rounded-[18px]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-4">
          <span className="text-[15px]">💓</span>
          <h2 className="text-[15px] font-bold text-cream">হার্টবিট</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {!enabled && autoArm && (
              <span className="rounded-full border border-sky-300/40 bg-sky-400/10 px-2 py-0.5 text-[10px] text-sky-300">
                🤖 নিজে চালু হবে
              </span>
            )}
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                enabled ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-300' : 'border-border-subtle bg-white/[0.02] text-muted'
              }`}
            >
              {enabled ? '🟢 চালু' : '🔴 বন্ধ'}
            </span>
          </div>
        </div>
        <p className="px-4 pb-3 pt-1 text-[12px] leading-relaxed text-muted">
          এজেন্ট নিজে থেকে মাঝে মাঝে জেগে ব্যবসার অবস্থা দেখে — দরকার হলে নিজে ব্যবস্থা নেয় বা আপনাকে জানায়। নিচে কখন কী করল দেখুন।
          {!enabled && autoArm && ' কাজ বাকি থাকলে এজেন্ট নিজেই হার্টবিট চালু করে নেবে।'}
        </p>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-3">
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => act(enabled ? 'disable' : 'enable', enabled ? 'হার্টবিট বন্ধ করলাম' : 'হার্টবিট চালু করলাম')}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
              enabled ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25' : 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            }`}
          >
            {enabled ? '⏸️ বন্ধ করো' : '▶️ চালু করো'}
          </button>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => act('test_now', 'হার্টবিট টেস্ট হলো')}
            className="rounded-full bg-white/[0.04] px-3.5 py-1.5 text-[12px] font-semibold text-cream transition-colors hover:bg-white/[0.08] disabled:opacity-50"
          >
            🧪 এখন টেস্ট করো
          </button>
          {feed && (
            <span className="ml-auto text-[11px] text-muted">
              আজ head জেগেছে {feed.wakesToday}/{feed.settings.dailyHeadWakeCap} বার
            </span>
          )}
        </div>

        {/* Timeline */}
        <div className="border-t border-border-subtle px-4 py-3">
          {loading ? (
            <p className="py-4 text-center text-[12px] text-muted">লোড হচ্ছে…</p>
          ) : !feed || feed.entries.length === 0 ? (
            <p className="py-4 text-center text-[12px] text-muted">এখনো কোনো হার্টবিট টিক নেই।</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {feed.entries.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 rounded-[12px] bg-white/[0.02] px-3 py-2">
                  <span className="mt-0.5 text-[14px] leading-none">{KIND_TAG[e.kind]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-cream">{KIND_LABEL[e.kind]}</span>
                      <span className="text-[10px] text-muted">{fmtTime(e.at)}</span>
                      {e.headWoke && <span className="rounded-full bg-amber-400/10 px-1.5 text-[9px] text-amber-300">head</span>}
                    </div>
                    <p className="mt-0.5 break-words text-[12px] leading-relaxed text-muted">{e.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

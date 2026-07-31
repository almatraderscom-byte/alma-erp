'use client'

/**
 * Mac control — the owner's switch, his pairing flow, and the audit trail.
 *
 * The capability ships OFF. Everything on this page exists so that turning it on
 * is a deliberate act he can see the consequences of: which Mac is connected,
 * exactly what has run on it, and one red button that stops everything.
 */
import { useCallback, useEffect, useState } from 'react'

interface MacDevice {
  id: string
  name: string
  online: boolean
  lastSeenAt: string | null
  pairedAt: string | null
}

interface HistoryRow {
  id: string
  action: string
  command: string | null
  policyLevel: string
  status: string
  exitCode: number | null
  createdAt: string
}

interface StatusResponse {
  enabled: boolean
  devices: MacDevice[]
  history: HistoryRow[]
}

const POLICY_LABEL: Record<string, { text: string; className: string }> = {
  green: { text: 'নিজে চলেছে', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  amber: { text: 'আপনি অনুমতি দিয়েছেন', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
}

const STATUS_LABEL: Record<string, string> = {
  done: '✅ হয়েছে',
  failed: '⚠️ ব্যর্থ',
  queued: '⏳ অপেক্ষায়',
  delivered: '▶️ চলছে',
  cancelled: '⛔ বাতিল',
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'এইমাত্র'
  if (min < 60) return `${min} মিনিট আগে`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} ঘণ্টা আগে`
  return `${Math.floor(hr / 24)} দিন আগে`
}

export default function MacControlPanel() {
  const [data, setData] = useState<StatusResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/mac-agent/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`status ${res.status}`)
      setData((await res.json()) as StatusResponse)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'লোড করা গেল না')
    }
  }, [])

  useEffect(() => {
    void load()
    // The point of this page is knowing whether the Mac is awake right now.
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/assistant/mac-agent/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = (await res.json()) as Record<string, unknown>
        if (!res.ok) throw new Error(String(json.error ?? res.status))
        if (body.action === 'pair_code') setPairCode(String(json.code))
        await load()
        return json
      } catch (err) {
        setError(err instanceof Error ? err.message : 'কাজটা করা গেল না')
        return null
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const enabled = data?.enabled ?? false
  const devices = data?.devices ?? []
  const online = devices.find((d) => d.online)

  return (
    <div className="space-y-4 px-4 pb-8">
      {/* Master switch */}
      <section className="rounded-2xl border border-black/10 bg-white/70 p-4 backdrop-blur dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Mac control</h2>
            <p className="mt-1 text-sm text-black/60 dark:text-white/60">
              বন্ধ থাকলে এজেন্ট আপনার Mac-এ কিছুই করতে পারে না — এটাই মূল সুইচ।
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: 'set_enabled', enabled: !enabled })}
            className={`shrink-0 rounded-xl px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              enabled ? 'bg-emerald-600' : 'bg-black/30 dark:bg-white/15'
            }`}
          >
            {enabled ? 'চালু আছে' : 'বন্ধ'}
          </button>
        </div>
      </section>

      {/* Devices */}
      <section className="rounded-2xl border border-black/10 bg-white/70 p-4 backdrop-blur dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">যুক্ত Mac</h2>
          <button
            type="button"
            disabled={busy || !enabled}
            onClick={() => void act({ action: 'pair_code' })}
            className="rounded-xl bg-[#E07A5F] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            নতুন Mac যোগ করুন
          </button>
        </div>

        {pairCode && (
          <div className="mt-3 rounded-xl border border-[#E07A5F]/40 bg-[#E07A5F]/10 p-3">
            <p className="text-sm text-black/70 dark:text-white/70">Mac-এ Terminal খুলে একবার চালান (কোড ১০ মিনিট চলবে):</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-black/85 p-3 text-xs text-white">
              cd ~/alma-erp/mac-agent && bash install.sh {pairCode}
            </pre>
          </div>
        )}

        <div className="mt-3 space-y-2">
          {devices.length === 0 && <p className="text-sm text-black/50 dark:text-white/50">এখনো কোনো Mac যুক্ত নেই।</p>}
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-black/20">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${d.online ? 'bg-emerald-400' : 'bg-black/25 dark:bg-white/30'}`} />
                  <span className="truncate text-sm font-medium">{d.name}</span>
                </div>
                <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">
                  {d.online ? 'অনলাইন' : `শেষ দেখা: ${timeAgo(d.lastSeenAt)}`}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: 'unpair', deviceId: d.id })}
                className="shrink-0 rounded-lg border border-black/15 px-3 py-1.5 text-xs text-black/70 dark:border-white/15 dark:text-white/70 disabled:opacity-50"
              >
                সরিয়ে দিন
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Stop */}
      <section className="rounded-2xl border border-red-500/25 bg-red-500/5 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-red-700 dark:text-red-200">সব থামান</h2>
            <p className="mt-1 text-sm text-black/60 dark:text-white/60">
              অপেক্ষায় থাকা ও চলতে যাওয়া সব কমান্ড বাতিল হবে।
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: 'stop' })}
            className="shrink-0 rounded-xl bg-red-500/80 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            STOP
          </button>
        </div>
      </section>

      {/* Audit trail */}
      <section className="rounded-2xl border border-black/10 bg-white/70 p-4 backdrop-blur dark:border-white/10 dark:bg-white/5">
        <h2 className="text-base font-semibold">কী কী চলেছে</h2>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          {online ? `${online.name}-এ` : 'আপনার Mac-এ'} এজেন্ট যা যা চালিয়েছে — সবুজ মানে শুধু পড়ার কমান্ড, হলুদ
          মানে আপনি অনুমতি দিয়েছিলেন।
        </p>

        <div className="mt-3 space-y-2">
          {(data?.history ?? []).length === 0 && <p className="text-sm text-black/50 dark:text-white/50">এখনো কিছু চালানো হয়নি।</p>}
          {(data?.history ?? []).map((h) => {
            const policy = POLICY_LABEL[h.policyLevel] ?? {
              text: h.policyLevel,
              className: 'bg-black/10 text-black/70 dark:bg-white/10 dark:text-white/70',
            }
            return (
              <div key={h.id} className="rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-black/20">
                <div className="flex items-start justify-between gap-3">
                  <code className="min-w-0 break-all text-xs text-black/80 dark:text-white/90">{h.command ?? h.action}</code>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] ${policy.className}`}>
                    {policy.text}
                  </span>
                </div>
                <p className="mt-1 text-xs text-black/50 dark:text-white/45">
                  {STATUS_LABEL[h.status] ?? h.status}
                  {h.exitCode !== null && h.exitCode !== 0 ? ` (exit ${h.exitCode})` : ''} · {timeAgo(h.createdAt)}
                </p>
              </div>
            )
          })}
        </div>
      </section>

      {error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p>
      )}
    </div>
  )
}

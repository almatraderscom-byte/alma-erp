'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface User {
  id: string
  name: string
  email: string | null
  role: string
}

interface StaffRow {
  id: string
  name: string
  role: string
  telegramChatId: string | null
  ntfyTopic: string | null
  active: boolean
  userId: string | null
  user: { id: string; name: string; email: string | null } | null
}

interface ApiResponse {
  staff: StaffRow[]
  eligibleUsers: User[]
}

const staggerContainer = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.07 },
  },
}

const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
}

export default function TradingStaffAdmin() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [draft, setDraft] = useState<{
    userId: string
    name: string
    role: string
    telegramChatId: string
  }>({ userId: '', name: '', role: 'p2p_trader', telegramChatId: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/assistant/internal/trading-staff/upsert', { method: 'GET' })
      const json: ApiResponse | { error: string } = await res.json()
      if ('error' in json) throw new Error(json.error)
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const upsert = async (body: Record<string, unknown>) => {
    setSaving(JSON.stringify(body))
    try {
      const res = await fetch('/api/assistant/internal/trading-staff/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || json.error) throw new Error(json.error ?? 'save_failed')
      await load()
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(null)
    }
  }

  if (loading) {
    return <div className="p-6 text-[#9B9BA4]">Loading Trading staff…</div>
  }
  if (error) {
    return <div className="p-6 text-rose-400">Error: {error}</div>
  }
  if (!data) return null

  const linkedUserIds = new Set(data.staff.map((s) => s.userId).filter(Boolean) as string[])
  const availableUsers = data.eligibleUsers.filter((u) => !linkedUserIds.has(u.id))

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="rounded-2xl border border-slate-200 bg-black/[0.03] backdrop-blur-md px-5 py-4">
        <h1 className="text-2xl font-bold text-cream">ALMA Trading — <span className="text-gold">Staff</span></h1>
        <p className="mt-1 text-sm text-zinc-500">
          Binance P2P trader-দের AgentStaff row লিঙ্ক করুন। প্রত্যেক TradingAccount-এর assigned User-এর সাথে
          এখান থেকে Telegram chat ID যোগ করুন — তাহলে agent এই staff-দের কাছে dispatch করতে পারবে।
        </p>
      </header>

      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-gold mb-3">Linked Trading staff ({data.staff.length})</h2>
        {data.staff.length === 0 ? (
          <p className="text-sm text-zinc-500">এখনো কোনো Trading staff লিঙ্ক করা হয়নি।</p>
        ) : (
          <motion.div
            className="space-y-3"
            variants={staggerContainer}
            initial="hidden"
            animate="show"
          >
            {data.staff.map((s) => (
              <motion.div
                key={s.id}
                variants={staggerItem}
                className={cn(
                  'rounded-xl border bg-black/[0.03] backdrop-blur-md p-4 space-y-3 transition-all',
                  s.active
                    ? 'border-slate-200 hover:border-gold/20'
                    : 'border-red-500/15 opacity-70',
                )}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-medium text-cream flex items-center gap-2">
                      {s.name}
                      <span className={cn(
                        'inline-block h-2.5 w-2.5 rounded-full',
                        s.active
                          ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                          : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]',
                      )} />
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      ERP: {s.user?.name ?? '— unlinked —'} · Role: {s.role} · {s.active ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => upsert({ id: s.id, active: !s.active })}
                      disabled={saving !== null}
                      className={cn(
                        'text-xs px-3 py-1.5 rounded-lg border backdrop-blur-sm transition-all',
                        s.active
                          ? 'border-red-500/25 bg-red-500/[0.06] text-red-300 hover:bg-red-500/10 hover:shadow-[0_0_10px_rgba(239,68,68,0.1)]'
                          : 'border-emerald-500/25 bg-emerald-500/[0.06] text-emerald-300 hover:bg-emerald-500/10 hover:shadow-[0_0_10px_rgba(16,185,129,0.1)]',
                      )}
                    >
                      {s.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <label className="space-y-1">
                    <span className="text-zinc-500 text-xs">Telegram chat ID</span>
                    <input
                      defaultValue={s.telegramChatId ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v !== (s.telegramChatId ?? '')) {
                          void upsert({ id: s.id, telegramChatId: v || null })
                        }
                      }}
                      placeholder="123456789"
                      className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-1.5 text-cream text-xs focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-zinc-500 text-xs">Role label</span>
                    <input
                      defaultValue={s.role}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || 'p2p_trader'
                        if (v !== s.role) void upsert({ id: s.id, role: v })
                      }}
                      className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-1.5 text-cream text-xs focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
                    />
                  </label>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>

      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-gold mb-3">Link a new Trading staff</h2>
        {availableUsers.length === 0 ? (
          <p className="text-sm text-zinc-500">
            সব eligible User ইতিমধ্যে লিঙ্ক করা আছে। নতুন trader add করতে User Management থেকে User তৈরি করুন
            (businessAccess-এ ALMA_TRADING রাখুন)।
          </p>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-black/[0.03] backdrop-blur-md p-4 space-y-3">
            <label className="block space-y-1">
              <span className="text-zinc-500 text-xs">ERP User</span>
              <select
                value={draft.userId}
                onChange={(e) => {
                  const u = availableUsers.find((x) => x.id === e.target.value)
                  setDraft((d) => ({ ...d, userId: e.target.value, name: u?.name ?? d.name }))
                }}
                className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-2 text-sm text-cream focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
              >
                <option value="" className="bg-white text-zinc-500">— select user —</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id} className="bg-white text-cream">
                    {u.name} {u.email ? `(${u.email})` : ''} — {u.role}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-zinc-500 text-xs">Staff name (override)</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="default = User.name"
                className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-1.5 text-sm text-cream focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
              />
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-zinc-500 text-xs">Role</span>
                <input
                  value={draft.role}
                  onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                  className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-1.5 text-sm text-cream focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-zinc-500 text-xs">Telegram chat ID</span>
                <input
                  value={draft.telegramChatId}
                  onChange={(e) => setDraft((d) => ({ ...d, telegramChatId: e.target.value }))}
                  placeholder="123456789"
                  className="w-full rounded-lg bg-black/[0.03] border border-slate-200 backdrop-blur-sm px-2.5 py-1.5 text-sm text-cream focus:outline-none focus:border-gold/40 focus:shadow-[0_0_12px_rgba(224,122,95,0.1)] transition-all"
                />
              </label>
            </div>
            <div className="pt-1">
              <button
                disabled={!draft.userId || saving !== null}
                onClick={() => {
                  void upsert({
                    userId: draft.userId,
                    name: draft.name || undefined,
                    role: draft.role || 'p2p_trader',
                    telegramChatId: draft.telegramChatId.trim() || null,
                    active: true,
                  }).then(() => {
                    setDraft({ userId: '', name: '', role: 'p2p_trader', telegramChatId: '' })
                  })
                }}
                className="rounded-lg bg-gold/10 border border-gold/30 backdrop-blur-sm px-4 py-2 text-sm font-semibold text-gold-lt disabled:opacity-50 hover:bg-gold/15 hover:shadow-[0_0_16px_rgba(224,122,95,0.15)] transition-all"
              >
                {saving ? 'Saving…' : 'Link staff'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

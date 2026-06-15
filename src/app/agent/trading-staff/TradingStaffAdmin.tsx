'use client'

import { useCallback, useEffect, useState } from 'react'

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
    return <div className="p-6 text-zinc-300">Loading Trading staff…</div>
  }
  if (error) {
    return <div className="p-6 text-rose-400">Error: {error}</div>
  }
  if (!data) return null

  const linkedUserIds = new Set(data.staff.map((s) => s.userId).filter(Boolean) as string[])
  const availableUsers = data.eligibleUsers.filter((u) => !linkedUserIds.has(u.id))

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">ALMA Trading — Staff</h1>
        <p className="text-sm text-zinc-400">
          Binance P2P trader-দের AgentStaff row লিঙ্ক করুন। প্রত্যেক TradingAccount-এর assigned User-এর সাথে
          এখান থেকে Telegram chat ID যোগ করুন — তাহলে agent এই staff-দের কাছে dispatch করতে পারবে।
        </p>
      </header>

      <section>
        <h2 className="text-lg font-medium mb-3">Linked Trading staff ({data.staff.length})</h2>
        {data.staff.length === 0 ? (
          <p className="text-sm text-zinc-500">এখনো কোনো Trading staff লিঙ্ক করা হয়নি।</p>
        ) : (
          <div className="space-y-3">
            {data.staff.map((s) => (
              <div key={s.id} className="rounded border border-zinc-800 bg-zinc-900/50 p-4 space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-zinc-500">
                      ERP: {s.user?.name ?? '— unlinked —'} · Role: {s.role} · {s.active ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => upsert({ id: s.id, active: !s.active })}
                      disabled={saving !== null}
                      className="text-xs px-3 py-1.5 rounded border border-zinc-700 hover:bg-zinc-800"
                    >
                      {s.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                  <label className="space-y-1">
                    <span className="text-zinc-400 text-xs">Telegram chat ID</span>
                    <input
                      defaultValue={s.telegramChatId ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v !== (s.telegramChatId ?? '')) {
                          void upsert({ id: s.id, telegramChatId: v || null })
                        }
                      }}
                      placeholder="123456789"
                      className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-zinc-400 text-xs">Role label</span>
                    <input
                      defaultValue={s.role}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || 'p2p_trader'
                        if (v !== s.role) void upsert({ id: s.id, role: v })
                      }}
                      className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5"
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Link a new Trading staff</h2>
        {availableUsers.length === 0 ? (
          <p className="text-sm text-zinc-500">
            সব eligible User ইতিমধ্যে লিঙ্ক করা আছে। নতুন trader add করতে User Management থেকে User তৈরি করুন
            (businessAccess-এ ALMA_TRADING রাখুন)।
          </p>
        ) : (
          <div className="rounded border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
            <label className="block space-y-1">
              <span className="text-zinc-400 text-xs">ERP User</span>
              <select
                value={draft.userId}
                onChange={(e) => {
                  const u = availableUsers.find((x) => x.id === e.target.value)
                  setDraft((d) => ({ ...d, userId: e.target.value, name: u?.name ?? d.name }))
                }}
                className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5 text-sm"
              >
                <option value="">— select user —</option>
                {availableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} {u.email ? `(${u.email})` : ''} — {u.role}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-zinc-400 text-xs">Staff name (override)</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="default = User.name"
                className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5 text-sm"
              />
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-zinc-400 text-xs">Role</span>
                <input
                  value={draft.role}
                  onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                  className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-zinc-400 text-xs">Telegram chat ID</span>
                <input
                  value={draft.telegramChatId}
                  onChange={(e) => setDraft((d) => ({ ...d, telegramChatId: e.target.value }))}
                  placeholder="123456789"
                  className="w-full rounded bg-black border border-zinc-700 px-2 py-1.5 text-sm"
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
                className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium"
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

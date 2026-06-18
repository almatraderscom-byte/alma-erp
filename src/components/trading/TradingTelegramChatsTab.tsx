'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, Input } from '@/components/ui'
import type { TradingTelegramChatRow } from '@/types/trading-telegram'

function formatSeen(at?: string | null) {
  if (!at) return 'Never'
  try {
    return new Date(at).toLocaleString('en-GB', {
      dateStyle: 'short',
      timeStyle: 'short',
      hour12: true,
    })
  } catch {
    return '—'
  }
}

export function TradingTelegramChatsTab({
  chats,
  newChat,
  setNewChat,
  onSaved,
}: {
  chats: TradingTelegramChatRow[]
  newChat: { chatId: string; title: string }
  setNewChat: (v: { chatId: string; title: string }) => void
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  async function saveChat(e: React.FormEvent) {
    e.preventDefault()
    const raw = newChat.chatId.trim()
    if (!raw) {
      toast.error('Enter the group chat ID from the bot message')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/trading/telegram/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newChat, chatId: raw, approved: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Could not save group')
        return
      }
      if (data.normalized && data.message) toast.success(data.message)
      else toast.success('Group registered and approved')
      setNewChat({ chatId: '', title: '' })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  async function testChat(chat: TradingTelegramChatRow) {
    setTestingId(chat.id)
    try {
      const res = await fetch('/api/trading/telegram/chats/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chat.chatId }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Test failed')
        return
      }
      toast.success(`Test message sent to ${data.title || chat.title || 'group'}`)
      onSaved()
    } finally {
      setTestingId(null)
    }
  }

  async function toggleApproved(chat: TradingTelegramChatRow) {
    setTogglingId(chat.id)
    try {
      const res = await fetch(`/api/trading/telegram/chats/${chat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: !chat.approved }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Update failed')
        return
      }
      toast.success(data.chat.approved ? 'Group approved' : 'Group marked inactive')
      onSaved()
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <p className="text-sm font-black text-cream">Register Telegram group</p>
        <p className="mt-1 text-xs text-muted">
          Add the bot to the group and send any message. If unregistered, the bot replies with the chat ID
          (must include the <span className="text-gold-lt">minus sign</span>, e.g. <code className="text-gold-lt">-100…</code>).
        </p>
        <form onSubmit={e => void saveChat(e)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.2fr_1fr_auto]">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted">
              Group chat ID
            </label>
            <Input
              placeholder="-1001234567890"
              value={newChat.chatId}
              onChange={e => setNewChat({ ...newChat, chatId: e.target.value.trim() })}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted">Title</label>
            <Input
              placeholder="ALMA Trading Live"
              value={newChat.title}
              onChange={e => setNewChat({ ...newChat, title: e.target.value })}
            />
          </div>
          <Button type="submit" variant="gold" disabled={saving} className="w-full lg:self-end">
            {saving ? 'Saving…' : 'Approve group'}
          </Button>
        </form>
      </Card>

      {!chats.length ? (
        <p className="text-center text-xs text-muted">No groups registered yet.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {chats.map(c => (
            <div key={c.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-cream">{c.chatId}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      c.approved
                        ? 'border border-green-400/40 bg-green-400/10 text-green-400'
                        : 'border border-amber-400/40 bg-amber-400/10 text-amber-300'
                    }`}
                  >
                    {c.approved ? 'Approved' : 'Inactive'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">{c.title || 'Untitled group'}</p>
                <p className="mt-0.5 text-[10px] text-muted-hi">Last message: {formatSeen(c.lastSeenAt)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={testingId === c.id || !c.approved}
                  onClick={() => void testChat(c)}
                >
                  {testingId === c.id ? 'Testing…' : 'Test connection'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={togglingId === c.id}
                  onClick={() => void toggleApproved(c)}
                >
                  {togglingId === c.id ? '…' : c.approved ? 'Deactivate' : 'Approve'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

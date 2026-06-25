'use client'

/**
 * AgentApprovalsTab — the "Agent" tab inside the ERP Approvals page.
 *
 * One place where every agent-proposed action (voice calls, dispatch, finance
 * confirms, …) waits for the owner's Approve / Reject, instead of being buried
 * in chat or Telegram. Lives in ERP space and talks to the agent ONLY over HTTP
 * (`/api/assistant/actions*`) — it never imports from `src/agent/`, honouring
 * the one-way dependency rule (ERP must not import agent code).
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Empty, Spinner } from '@/components/ui'

type AgentAction = {
  id: string
  type: string
  status: string
  summary: string | null
  costEstimate: number | null
  conversationId: string | null
  result: unknown
  createdAt: string
  expired: boolean
}

type StatusFilter = 'pending' | 'all'

const TYPE_LABELS: Record<string, string> = {
  agent_voice_call: 'Voice call (two-way)',
  outbound_call: 'Voice call (one-way)',
  dispatch_staff_tasks: 'Dispatch tasks',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ')
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return 'এইমাত্র'
  if (mins < 60) return `${mins} মিনিট আগে`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} ঘণ্টা আগে`
  const days = Math.floor(hrs / 24)
  return `${days} দিন আগে`
}

export default function AgentApprovalsTab() {
  const [actions, setActions] = useState<AgentAction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('pending')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/assistant/actions?status=${filter}&limit=50`, {
        cache: 'no-store',
      })
      if (res.status === 401 || res.status === 403) {
        setError('অনুমতি নেই — আবার লগইন করুন।')
        setActions([])
        return
      }
      if (!res.ok) {
        setError('তালিকা লোড করা যায়নি।')
        setActions([])
        return
      }
      const json = (await res.json()) as { actions?: AgentAction[] }
      setActions(Array.isArray(json.actions) ? json.actions : [])
    } catch {
      setError('নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।')
      setActions([])
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void load()
  }, [load])

  const act = useCallback(
    async (id: string, kind: 'approve' | 'reject') => {
      setBusyId(id)
      setNotice(null)
      try {
        const res = await fetch(`/api/assistant/actions/${id}/${kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
        if (res.status === 410) {
          setNotice('অনুমোদনের সময় শেষ — কার্ডটি মেয়াদোত্তীর্ণ।')
        } else if (res.status === 409) {
          setNotice('এই অ্যাকশনটি ইতিমধ্যে সম্পন্ন হয়েছে।')
        } else if (!res.ok) {
          setNotice(kind === 'approve' ? 'অনুমোদন ব্যর্থ হয়েছে।' : 'বাতিল ব্যর্থ হয়েছে।')
        } else {
          setNotice(kind === 'approve' ? '✓ অনুমোদিত হয়েছে।' : '✓ বাতিল করা হয়েছে।')
        }
      } catch {
        setNotice('নেটওয়ার্ক সমস্যা — আবার চেষ্টা করুন।')
      } finally {
        setBusyId(null)
        void load()
      }
    },
    [load],
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant={filter === 'pending' ? 'gold' : 'ghost'}
            onClick={() => setFilter('pending')}
          >
            Pending
          </Button>
          <Button
            size="xs"
            variant={filter === 'all' ? 'gold' : 'ghost'}
            onClick={() => setFilter('all')}
          >
            All
          </Button>
        </div>
        <Button size="xs" variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'লোড হচ্ছে…' : 'Refresh'}
        </Button>
      </div>

      {notice && (
        <div className="rounded-xl border border-border-subtle bg-bg-2 px-3.5 py-2.5 text-xs text-muted-hi">
          {notice}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size="md" />
        </div>
      ) : error ? (
        <Empty icon="⚠️" title="সমস্যা" desc={error} action={<Button size="sm" variant="ghost" onClick={() => void load()}>আবার চেষ্টা</Button>} />
      ) : actions.length === 0 ? (
        <Empty
          icon="🤖"
          title={filter === 'pending' ? 'কোনো অপেক্ষমাণ অ্যাকশন নেই' : 'কোনো অ্যাকশন নেই'}
          desc="এজেন্ট কোনো অনুমোদনের অনুরোধ পাঠালে এখানে দেখা যাবে।"
        />
      ) : (
        <div className="space-y-3">
          {actions.map((a) => {
            const isPending = a.status === 'pending'
            const disabled = busyId === a.id || !isPending
            return (
              <Card key={a.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-gold/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold-dim">
                        {typeLabel(a.type)}
                      </span>
                      {!isPending && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                          {a.status}
                        </span>
                      )}
                      {a.expired && isPending && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-danger">
                          মেয়াদ শেষ
                        </span>
                      )}
                    </div>
                    <p className="break-words text-sm text-cream">
                      {a.summary || 'বিস্তারিত নেই'}
                    </p>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-muted">
                    {timeAgo(a.createdAt)}
                  </span>
                </div>

                {typeof a.costEstimate === 'number' && a.costEstimate > 0 && (
                  <p className="text-[11px] text-muted">
                    আনুমানিক খরচ: <span className="text-cream">৳{a.costEstimate}</span>
                  </p>
                )}

                {isPending && (
                  <div className="flex gap-2 border-t border-border-subtle pt-3">
                    {a.expired ? (
                      // Expired card: can't be approved/rejected anymore, but the
                      // owner must be able to clear it. "সরান" hits the reject
                      // route, which transitions it to terminal 'expired' (410)
                      // and it drops out of the queue on reload.
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busyId === a.id}
                        loading={busyId === a.id}
                        onClick={() => void act(a.id, 'reject')}
                      >
                        সরান
                      </Button>
                    ) : (
                      <>
                        <Button
                          size="xs"
                          variant="gold"
                          disabled={disabled}
                          loading={busyId === a.id}
                          onClick={() => void act(a.id, 'approve')}
                        >
                          Approve
                        </Button>
                        <Button
                          size="xs"
                          variant="danger"
                          disabled={disabled}
                          onClick={() => void act(a.id, 'reject')}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

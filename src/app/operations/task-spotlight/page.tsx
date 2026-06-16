'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { unwrapApiData } from '@/lib/safe-api-response'
import { useSession } from 'next-auth/react'
import { useBusiness } from '@/contexts/BusinessContext'
import { isSystemOwner } from '@/lib/roles'
import { Button, Card, Input, PageHeader, Select, Skeleton } from '@/components/ui'
import { useRouter } from 'next/navigation'

type TaskRow = {
  id: string
  title: string
  description: string
  priority: string
  status: string
  deadline: string | null
  stats: { assigned: number; completed: number; acknowledged: number; completionRate: number }
  assignments: Array<{
    id: string
    userId: string
    status: string
    assignee: { id: string; name: string; email: string } | null
  }>
}

type UserOption = { id: string; name: string; email: string; role: string }

export default function TaskSpotlightAdminPage() {
  const router = useRouter()
  const { data: session, status } = useSession()
  const { business } = useBusiness()
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('NORMAL')
  const [deadline, setDeadline] = useState('')
  const [bannerUrl, setBannerUrl] = useState('')
  const [assigneeIds, setAssigneeIds] = useState<string[]>([])
  const [ackRequired, setAckRequired] = useState(true)
  const [allowDismiss, setAllowDismiss] = useState(false)

  const allowed = status !== 'loading' && isSystemOwner(session)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tResult, uResult] = await Promise.all([
        safeFetchJsonWithToast<{ tasks: TaskRow[] }>(
          `/api/operational-tasks?business_id=${encodeURIComponent(business.id)}`,
          { cache: 'no-store', toastOnError: false },
        ),
        safeFetchJsonWithToast<{ employees: UserOption[] }>(
          `/api/operational-tasks/assignees?business_id=${encodeURIComponent(business.id)}`,
          { cache: 'no-store', toastOnError: false },
        ),
      ])
      if (!tResult.ok) throw new Error(tResult.error.message)
      if (!uResult.ok) throw new Error(uResult.error.message)
      const tj = tResult.data
      const uj = uResult.data
      setTasks(tj.tasks || [])
      const list = uj.employees || []
      setUsers(list)
      setAssigneeIds(prev => prev.filter(id => list.some(u => u.id === id)))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [business.id])

  useEffect(() => {
    if (!allowed) return
    void load()
  }, [allowed, load])

  useEffect(() => {
    if (status !== 'loading' && !allowed) router.replace('/')
  }, [status, allowed, router])

  if (status === 'loading' || !allowed) {
    return <div className="p-8"><Skeleton className="h-40 w-full" /></div>
  }

  async function createTask() {
    if (!title.trim() || !description.trim() || !assigneeIds.length) {
      toast.error('Title, description, and at least one assignee required')
      return
    }
    setSaving(true)
    try {
      const result = await safeFetchJsonWithToast('/api/operational-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          priority,
          deadline: deadline || null,
          banner_image_url: bannerUrl || null,
          acknowledgment_required: ackRequired,
          allow_dismiss: allowDismiss,
          business_id: business.id,
          assignee_user_ids: assigneeIds,
        }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Task spotlight published')
      setTitle('')
      setDescription('')
      setAssigneeIds([])
      setDeadline('')
      setBannerUrl('')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function archiveTask(taskId: string) {
    try {
      const result = await safeFetchJsonWithToast(`/api/operational-tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Task archived')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function resend(taskId: string, assignmentId: string) {
    try {
      const result = await safeFetchJsonWithToast(`/api/operational-tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend', assignment_id: assignmentId }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Spotlight reset — employee will see on next Start Work')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  function toggleAssignee(id: string) {
    setAssigneeIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  return (
    <div className="space-y-6 pb-16">
      <PageHeader
        title="Task Spotlight"
        subtitle="Operations → assign premium operational instructions to employees. Shown fullscreen after Start Work."
      />

      <Card className="p-5 border-gold-dim/30 bg-gradient-to-br from-gold/5 via-card to-transparent space-y-4">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Create spotlight task</p>
        <Input placeholder="Task title" value={title} onChange={e => setTitle(e.target.value)} />
        <textarea
          className="w-full rounded-xl border border-border bg-black/[0.04] px-3 py-2 text-sm text-cream placeholder:text-zinc-600 min-h-[100px]"
          placeholder="Instructions for the employee…"
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={4}
        />
        <div className="grid gap-3 md:grid-cols-3">
          <Select
            value={priority}
            onChange={setPriority}
            options={[
              { label: 'Low', value: 'LOW' },
              { label: 'Normal', value: 'NORMAL' },
              { label: 'High', value: 'HIGH' },
              { label: 'Critical', value: 'CRITICAL' },
            ]}
          />
          <Input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} />
          <Input placeholder="Banner image URL (optional)" value={bannerUrl} onChange={e => setBannerUrl(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={ackRequired} onChange={e => setAckRequired(e.target.checked)} />
          Acknowledgment required
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={allowDismiss} onChange={e => setAllowDismiss(e.target.checked)} />
          Allow dismiss without completing
        </label>
        <div className="max-h-40 overflow-y-auto rounded-xl border border-border p-3 space-y-1">
          <p className="text-[10px] font-bold text-zinc-500 mb-2">
            Assign employees · {business.shortName} scope only ({users.length})
          </p>
          {users.map(u => (
            <label key={u.id} className="flex items-center gap-2 text-xs text-cream cursor-pointer">
              <input
                type="checkbox"
                checked={assigneeIds.includes(u.id)}
                onChange={() => toggleAssignee(u.id)}
              />
              {u.name} <span className="text-zinc-600">({u.email})</span>
            </label>
          ))}
        </div>
        <Button variant="gold" disabled={saving} onClick={() => void createTask()}>
          {saving ? 'Publishing…' : 'Publish task spotlight'}
        </Button>
      </Card>

      <Card className="p-5 space-y-4">
        <p className="text-sm font-bold text-cream">Live tasks</p>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : !tasks.length ? (
          <p className="text-xs text-zinc-500">No operational tasks yet.</p>
        ) : (
          <div className="space-y-4">
            {tasks.map(t => (
              <div key={t.id} className="rounded-xl border border-border bg-black/[0.03] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-black text-cream">{t.title}</p>
                    <p className="text-[10px] text-zinc-500 mt-1">
                      {t.priority} · {t.status} · {t.stats.completionRate}% complete ({t.stats.completed}/{t.stats.assigned})
                    </p>
                  </div>
                  <Button size="xs" variant="secondary" onClick={() => void archiveTask(t.id)}>
                    Archive
                  </Button>
                </div>
                <ul className="mt-3 space-y-1 text-[11px]">
                  {t.assignments.map(a => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
                      <span className="text-zinc-400">
                        {a.assignee?.name || a.userId} — <span className="text-gold-lt">{a.status}</span>
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => void resend(t.id, a.id)}>
                        Resend spotlight
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

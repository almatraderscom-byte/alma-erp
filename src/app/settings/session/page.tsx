'use client'
import { useEffect, useState } from 'react'
import { PageHeader, Card, Button } from '@/components/ui'
import { useActor } from '@/contexts/ActorContext'
import { ALMA_ROLE_OPTIONS, type AlmaRole } from '@/lib/roles'
import toast from 'react-hot-toast'

export default function SessionSettingsPage() {
  const { actorName, role, setActorSession } = useActor()
  const [name, setName] = useState(actorName)
  const [draftRole, setDraftRole] = useState<AlmaRole>(role)

  useEffect(() => {
    setName(actorName)
    setDraftRole(role)
  }, [actorName, role])

  function save() {
    setActorSession(name, draftRole)
    toast.success('Session saved — identity sent with writes for the audit log')
  }

  return (
    <>
      <PageHeader
        title="Session"
        subtitle="Who is operating the ERP — used for lightweight audit trails (paired with server-side API secret)."
      />
      <div className="p-4 md:p-6 max-w-lg space-y-4">
        <Card className="p-5 space-y-4">
          <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Display name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
              placeholder="e.g. Maruf · Alma Ops"
              maxLength={120}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Role</span>
            <select
              value={draftRole}
              onChange={e => setDraftRole(e.target.value as AlmaRole)}
              className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
            >
              {ALMA_ROLE_OPTIONS.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <p className="text-[11px] text-zinc-500 leading-snug">
            {ALMA_ROLE_OPTIONS.find(o => o.id === draftRole)?.hint}
          </p>
          <Button variant="gold" className="w-full justify-center" type="button" onClick={save}>
            Save session
          </Button>
        </Card>
      </div>
    </>
  )
}

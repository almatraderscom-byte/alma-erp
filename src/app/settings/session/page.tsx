'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { PageHeader, Card, Button, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { useSession } from 'next-auth/react'
import { normalizeAlmaRole } from '@/lib/roles'
import toast from 'react-hot-toast'
import { ProfilePhotoSection } from '@/components/profile/ProfilePhotoSection'

function apiHost(url: string | null | undefined): string {
  if (!url) return '—'
  try {
    return new URL(url).hostname
  } catch {
    return '—'
  }
}

type HealthJson = {
  ok: boolean
  timestamp: string
  environment: string
  gas_clasp_version?: string | null
  frontend?: { git_commit?: string | null }
  api?: { next_public_api_url?: string | null; gas_deployment_id?: string | null }
  gas?: Record<string, unknown>
}

export default function SessionSettingsPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const { business } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)

  const [name, setName] = useState(session?.user?.name || '')
  const [phone, setPhone] = useState('')
  const [pwCur, setPwCur] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPw, setSavingPw] = useState(false)
  const [health, setHealth] = useState<HealthJson | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)
  const [profileImageUrl, setProfileImageUrl] = useState<string | null>(null)

  useEffect(() => {
    setName(session?.user?.name || '')
  }, [session?.user?.name])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/users/me', { cache: 'no-store' })
        const j = await res.json().catch(() => ({}))
        if (res.ok && !cancelled) {
          if (j.user?.phone) setPhone(String(j.user.phone))
          setProfileImageUrl(j.user?.profileImageUrl ?? null)
        }
      } catch {
        /* ignore */
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setHealthLoading(true)
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        const json = (await res.json()) as HealthJson
        if (!cancelled) setHealth(json)
      } catch {
        if (!cancelled) setHealth(null)
      } finally {
        if (!cancelled) setHealthLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    setSavingProfile(true)
    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || null }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(j.error || 'Could not save')
        return
      }
      toast.success('Profile updated')
      router.refresh()
    } finally {
      setSavingProfile(false)
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pwNew.length < 8) {
      toast.error('New password must be 8+ characters')
      return
    }
    setSavingPw(true)
    try {
      const res = await fetch('/api/users/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: pwCur, newPassword: pwNew }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(j.error || 'Could not change password')
        return
      }
      toast.success('Password changed')
      setPwCur('')
      setPwNew('')
    } finally {
      setSavingPw(false)
    }
  }

  const gasStamp =
    health?.gas && typeof health.gas.gas_release_stamp === 'string'
      ? health.gas.gas_release_stamp
      : '—'

  const claspVer = health?.gas_clasp_version || '—'

  return (
    <>
      <PageHeader
        title="Session"
        subtitle="Signed-in identity · profile · diagnostics"
      />
      <div className="p-4 md:p-6 max-w-lg space-y-4">
        {session?.user?.id && (
          <ProfilePhotoSection
            userId={session.user.id}
            name={name || session.user.name || 'Account'}
            email={session.user.email}
            imageUrl={profileImageUrl}
            showSettingsLink={false}
            onUpdated={payload => setProfileImageUrl(payload.imageUrl || null)}
          />
        )}

        <Card className="p-5 border-gold-dim/25 bg-[#0c0c10] space-y-3">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Build / backend</p>
          {healthLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : health ? (
            <dl className="grid grid-cols-1 gap-2 text-[11px]">
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Frontend git</dt><dd className="font-mono text-cream truncate max-w-[55%]" title={health.frontend?.git_commit || ''}>{health.frontend?.git_commit || '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">GAS stamp</dt><dd className="font-mono text-gold-lt">{gasStamp}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Clasp @NN</dt><dd className="font-mono text-zinc-300">{claspVer}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Deployment ID</dt><dd className="font-mono text-cream truncate max-w-[55%]" title={health.api?.gas_deployment_id || ''}>{health.api?.gas_deployment_id || '—'}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">API URL host</dt><dd className="font-mono text-zinc-400 truncate max-w-[55%]" title={health.api?.next_public_api_url || ''}>{apiHost(health.api?.next_public_api_url)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Environment</dt><dd className="text-zinc-300">{health.environment}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Checked</dt><dd className="font-mono text-zinc-500">{health.timestamp}</dd></div>
              <div className="flex justify-between gap-3 pt-2 border-t border-border"><dt className="text-zinc-500">Business</dt><dd className="text-cream font-semibold">{business.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Role</dt><dd className="text-cream font-semibold">{role.replace(/_/g, ' ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Account</dt><dd className="font-mono text-zinc-400 truncate max-w-[60%]" title={session?.user?.email || ''}>{session?.user?.email || '—'}</dd></div>
            </dl>
          ) : (
            <p className="text-xs text-red-400">Could not load /api/health</p>
          )}
          {!healthLoading && health && !health.ok && (
            <p className="text-[10px] text-amber-400">Backend probe returned ok:false — compare NEXT_PUBLIC_API_URL with clasp deployment.</p>
          )}
        </Card>

        <Card className="p-5 space-y-4">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Display name & contact</p>
          <form onSubmit={saveProfile} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Display name</span>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
                placeholder="Full name"
                maxLength={120}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Phone</span>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
                placeholder="+880 …"
              />
            </label>
            <Button variant="gold" className="w-full justify-center" type="submit" disabled={savingProfile}>
              {savingProfile ? 'Saving…' : 'Save profile'}
            </Button>
          </form>
        </Card>

        <Card className="p-5 space-y-4">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Password</p>
          <form onSubmit={changePassword} className="space-y-3">
            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Current</span>
              <input
                type="password"
                autoComplete="current-password"
                value={pwCur}
                onChange={e => setPwCur(e.target.value)}
                className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">New (8+ chars)</span>
              <input
                type="password"
                autoComplete="new-password"
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
                className="w-full rounded-xl bg-card border border-border px-3 py-2.5 text-sm text-cream"
              />
            </label>
            <Button variant="secondary" className="w-full justify-center" type="submit" disabled={savingPw}>
              {savingPw ? 'Updating…' : 'Change password'}
            </Button>
          </form>
          <p className="text-[11px] text-zinc-600">
            Forgot your password? Use the recovery flow from the login screen — it emails a reset link when outbound mail is configured.
          </p>
        </Card>
      </div>
    </>
  )
}

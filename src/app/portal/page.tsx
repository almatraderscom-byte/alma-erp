'use client'

import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Button, Card, Empty, Input, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { isSystemOwner, normalizeAlmaRole } from '@/lib/roles'
import type { EmployeeWalletResponse, WalletRequestDto } from '@/types/payroll-wallet'
import { FaceVerificationCheckIn } from '@/components/attendance/FaceVerificationCheckIn'
import { PenaltyAppealModal } from '@/components/attendance/PenaltyAppealModal'
import { PenaltyAppealStatus } from '@/components/attendance/PenaltyAppealStatus'
import { ProfilePhotoSection } from '@/components/profile/ProfilePhotoSection'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'

type MeUser = {
  id: string
  email: string
  name: string
  phone: string | null
  role: string
  businessAccess: string
  employeeIdGas: string | null
  joiningDate: string | null
  salaryHint: string | null
  profileImageUrl: string | null
  isSystemOwner?: boolean
  profile?: {
    source: string
    roleTitle: string | null
    shift: string | null
    status: string
    salary: number | null
  }
}

type AttendanceRecordDto = {
  id: string
  attendanceDate: string
  checkInAt: string
  checkOutAt: string | null
  totalWorkMinutes: number
  lateMinutes: number
  penaltyAmount: number
  trustStatus: string
  suspiciousReasons: string[]
  verificationRequired: boolean
  faceVerified: boolean
  faceVerifiedAt: string | null
  selfieCount: number
  waiverRequests: AttendanceWaiverDto[]
}

type AttendanceWaiverDto = {
  id: string
  status: string
  statusLabel?: string
  requestType?: string
  reason: string
  originalPenaltyAmount: number
  requestedReductionAmount: number | null
  approvedReductionAmount: number | null
  finalAppliedPenalty?: number
  hasAttachment?: boolean
  adminNote?: string | null
  createdAt: string
}

type MyAttendanceResponse = {
  today: AttendanceRecordDto | null
  records: AttendanceRecordDto[]
  waivers: AttendanceWaiverDto[]
  summary: {
    presentDays: number
    lateCount: number
    totalPenalties: number
    waivedPenalties: number
    averageWorkMinutes: number
  }
}

export default function EmployeePortalPage() {
  const { data: session } = useSession()
  const { business } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)
  const systemOwner = isSystemOwner(session)

  const [me, setMe] = useState<MeUser | null>(null)
  const [loadingMe, setLoadingMe] = useState(true)
  const [wallet, setWallet] = useState<EmployeeWalletResponse | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)
  const [attendance, setAttendance] = useState<MyAttendanceResponse | null>(null)
  const [attendanceLoading, setAttendanceLoading] = useState(true)

  const empId = systemOwner
    ? null
    : me?.employeeIdGas?.trim() || session?.user?.employeeIdGas?.trim() || null
  const profileReady = systemOwner || !loadingMe

  const profileIdentity = me ?? (session?.user?.id
    ? {
        id: session.user.id,
        email: session.user.email || '',
        name: session.user.name || 'Account',
        phone: null,
        role: role,
        businessAccess: '',
        employeeIdGas: null,
        joiningDate: null,
        salaryHint: null,
        profileImageUrl: null,
      }
    : null)

  const loadMe = useCallback(async () => {
    setLoadingMe(true)
    try {
      const res = await fetch(`/api/users/me?business_id=${business.id}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setMe(j.user as MeUser)
    } catch {
      setMe(null)
    } finally {
      setLoadingMe(false)
    }
  }, [business.id])

  useEffect(() => {
    void loadMe()
  }, [loadMe])

  const loadWallet = useCallback(async () => {
    if (systemOwner) {
      setWallet(null)
      setWalletLoading(false)
      return
    }
    if (!empId) {
      setWallet(null)
      setWalletLoading(false)
      return
    }
    setWalletLoading(true)
    try {
      const res = await fetch(`/api/payroll/wallet/${encodeURIComponent(empId)}?business_id=${business.id}`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || res.statusText)
      setWallet(j as EmployeeWalletResponse)
    } catch (e) {
      toast.error((e as Error).message || 'Could not load wallet')
      setWallet(null)
    } finally {
      setWalletLoading(false)
    }
  }, [business.id, empId, systemOwner])

  useEffect(() => {
    void loadWallet()
  }, [loadWallet])

  const loadAttendance = useCallback(async () => {
    if (!profileReady) return
    if (!empId) {
      setAttendance(null)
      setAttendanceLoading(false)
      return
    }
    setAttendanceLoading(true)
    try {
      const res = await fetch(`/api/attendance?business_id=${business.id}&scope=me`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = String(j.error || res.statusText)
        if (res.status === 503 && err.includes('schema')) {
          throw new Error('Attendance is updating on the server. Try again in a minute or contact admin.')
        }
        throw new Error(err)
      }
      setAttendance(j as MyAttendanceResponse)
    } catch (e) {
      const msg = (e as Error).message || 'Could not load attendance'
      if (!msg.toLowerCase().includes('forbidden')) {
        toast.error(msg)
      }
      setAttendance(null)
    } finally {
      setAttendanceLoading(false)
    }
  }, [business.id, empId, profileReady])

  useEffect(() => {
    void loadAttendance()
  }, [loadAttendance])

  useRegisterMobileRefresh(
    useCallback(async () => {
      await Promise.all([loadMe(), loadWallet(), loadAttendance()])
    }, [loadMe, loadWallet, loadAttendance]),
    !systemOwner,
  )

  const ordersHref = business.id === 'CREATIVE_DIGITAL_IT' ? '/digital/projects' : '/orders/new'

  return (
    <FinancePageChrome
      title="My desk"
      subtitle="Wallet balance · withdrawal requests · payroll history"
      actions={(
        <div className="flex gap-2 flex-wrap justify-end">
          <Link href={ordersHref}>
            <Button size="xs" variant="gold">{business.id === 'CREATIVE_DIGITAL_IT' ? 'Projects' : 'New order'}</Button>
          </Link>
          <Link href="/invoice"><Button size="xs" variant="secondary">Invoices</Button></Link>
        </div>
      )}
    >
      {profileIdentity && (
        <div className="mb-4">
          {loadingMe && !me ? (
            <Skeleton className="h-52 w-full rounded-2xl" />
          ) : (
            <ProfilePhotoSection
              userId={profileIdentity.id}
              name={profileIdentity.name}
              email={profileIdentity.email}
              imageUrl={me?.profileImageUrl ?? profileIdentity.profileImageUrl}
              onUpdated={payload => {
                setMe(current => (current ? { ...current, profileImageUrl: payload.imageUrl || null } : current))
              }}
            />
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {systemOwner ? (
          <SystemOwnerCard businessName={business.name} />
        ) : (
          <AttendanceCard
            businessId={business.id}
            empLinked={Boolean(empId)}
            loading={attendanceLoading}
            attendance={attendance}
            onRefresh={() => {
              void loadAttendance()
              void loadWallet()
            }}
          />
        )}

        <Card className="p-5 space-y-3 border-gold-dim/25 bg-[#0c0c10]">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Account details</p>
          {loadingMe ? <Skeleton className="h-28 w-full" /> : !me ? (
            <div>
            <Empty icon="◇" title="Could not load full profile" desc="Your photo is saved above. Retry to load payroll and HR details for this business." />
            <div className="mt-3">
              <Button size="xs" variant="secondary" onClick={() => void loadMe()}>Retry profile</Button>
            </div>
            </div>
          ) : (
            <>
            <dl className="grid gap-2 text-[11px]">
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Name</dt><dd className="text-cream font-medium">{me.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Email</dt><dd className="font-mono text-zinc-400 truncate max-w-[55%]" title={me.email}>{me.email}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Role</dt><dd className="text-gold-lt">{role.replace(/_/g, ' ')}</dd></div>
              {me.profile?.roleTitle && <div className="flex justify-between gap-3"><dt className="text-zinc-500">Profile role</dt><dd className="text-zinc-400">{me.profile.roleTitle}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Business scope</dt><dd className="text-zinc-400 text-right">{me.businessAccess.replace(/,/g, ', ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">HR employee ID</dt><dd className="font-mono text-zinc-400">{systemOwner ? 'System owner - not required' : me.employeeIdGas || '— link in Users'}</dd></div>
              {me.profile?.shift && <div className="flex justify-between gap-3"><dt className="text-zinc-500">Shift</dt><dd className="text-zinc-400">{me.profile.shift}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-zinc-500">Salary hint</dt><dd className="font-mono text-gold">
                {me.salaryHint != null ? `৳ ${Number(me.salaryHint).toLocaleString('en-BD')}` : '—'}
              </dd></div>
            </dl>
            </>
          )}
        </Card>

        {!systemOwner && <WalletOverviewCard loading={walletLoading} wallet={wallet} />}

        {!systemOwner && (
          <WalletRequestCard
            businessId={business.id}
            empLinked={Boolean(empId)}
            onSubmitted={() => {
              void loadWallet()
              void loadMe()
            }}
          />
        )}

        {!systemOwner && <Card className="p-5 md:col-span-2">
          <p className="text-sm font-bold text-cream mb-3">Wallet transaction history</p>
          {!empId ? (
            <p className="text-[11px] text-zinc-500">Link your HR employee ID (Users settings) to activate the payroll wallet.</p>
          ) : walletLoading ? (
            <Skeleton className="h-36 w-full" />
          ) : !(wallet?.entries ?? []).length ? (
            <p className="text-[11px] text-zinc-500">No wallet entries yet. HR can run monthly salary accruals from Payroll.</p>
          ) : (
            <div className="divide-y divide-border max-h-56 overflow-y-auto text-[11px]">
              {(wallet!.entries ?? []).slice().reverse().slice(0, 60).map(tx => (
                <div key={String(tx.id ?? `${tx.date}-${tx.type}`)} className="py-2 grid grid-cols-[82px_1fr_auto_auto] gap-2 items-center">
                  <span className="text-zinc-500 font-mono">{String(tx.date).slice(0, 10)}</span>
                  <span className="text-cream">{tx.type.replace(/_/g, ' ')}</span>
                  <span className={tx.signedAmount >= 0 ? 'font-mono text-green-400' : 'font-mono text-red-400'}>
                    {tx.signedAmount >= 0 ? '+' : '-'}৳ {Math.abs(tx.signedAmount).toLocaleString('en-BD')}
                  </span>
                  <span className="font-mono text-gold-lt">৳ {tx.runningBalance.toLocaleString('en-BD')}</span>
                </div>
              ))}
            </div>
          )}
        </Card>}

        {!systemOwner && <Card className="p-5 md:col-span-2 bg-black/25 border-border">
          <p className="text-sm font-bold text-cream mb-2">Pending requests</p>
          <RequestList requests={wallet?.requests ?? []} />
        </Card>}
      </div>
    </FinancePageChrome>
  )
}

function money(n: unknown) {
  return `৳ ${Number(n || 0).toLocaleString('en-BD')}`
}

function SystemOwnerCard({ businessName }: { businessName: string }) {
  return (
    <Card className="p-5 md:col-span-2 border-gold-dim/30 bg-gradient-to-br from-gold/10 via-card to-black/30">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">System owner mode</p>
      <h2 className="mt-2 text-xl font-black text-cream">Owner control active</h2>
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-zinc-400">
        You are operating {businessName} as a system owner. Employee attendance, personal wallet requests, payroll linkage,
        and staff profile requirements are intentionally skipped for this account.
      </p>
      <div className="mt-4 grid gap-2 md:grid-cols-3 text-[11px]">
        <WalletStat label="Access mode" value="Owner" tone="text-gold-lt" />
        <WalletStat label="Employee ID" value="Not required" />
        <WalletStat label="Payroll wallet" value="Not personal" />
      </div>
    </Card>
  )
}

function minutesText(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return `${h}h ${m}m`
}

function AttendanceCard({
  businessId,
  empLinked,
  loading,
  attendance,
  onRefresh,
}: {
  businessId: string
  empLinked: boolean
  loading: boolean
  attendance: MyAttendanceResponse | null
  onRefresh: () => void
}) {
  const [busy, setBusy] = useState<'out' | 'cancel' | null>(null)
  const [appealOpen, setAppealOpen] = useState(false)
  const [verifyRecord, setVerifyRecord] = useState<AttendanceRecordDto | null>(null)
  const [faceCheckInOpen, setFaceCheckInOpen] = useState(false)
  const today = attendance?.today || null

  async function postCheckOut() {
    setBusy('out')
    try {
      const res = await fetch('/api/attendance/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Attendance update failed')
      toast.success('Work ended')
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function cancelAppeal(waiverId: string) {
    setBusy('cancel')
    try {
      const res = await fetch(`/api/attendance/waivers/${waiverId}?business_id=${encodeURIComponent(businessId)}`, {
        method: 'DELETE',
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not cancel')
      toast.success('Review request cancelled')
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-5 md:col-span-2 border-gold-dim/30 bg-gradient-to-br from-gold/10 via-card to-black/30">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Today attendance</p>
          <h2 className="mt-2 text-xl font-black text-cream">{today ? (today.checkOutAt ? 'Workday completed' : 'Work is running') : 'Ready to start work'}</h2>
          <p className="mt-1 text-xs text-zinc-500">Office time: 9:00 AM - 9:00 PM. Late penalties sync to your wallet automatically.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 min-w-[220px]">
          <Button
            variant="gold"
            className="h-12 justify-center text-center"
            disabled={!empLinked || loading || Boolean(today) || busy !== null}
            onClick={() => setFaceCheckInOpen(true)}
          >
            📸 Start Work Verification
          </Button>
          <Button
            variant="secondary"
            className="h-12 justify-center"
            disabled={!empLinked || loading || !today || Boolean(today?.checkOutAt) || busy !== null}
            onClick={() => void postCheckOut()}
          >
            {busy === 'out' ? 'Ending...' : 'End Work'}
          </Button>
        </div>
      </div>

      {loading ? <Skeleton className="mt-4 h-28 w-full" /> : !empLinked ? (
        <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300">Ask an admin to link your HR employee ID before using attendance.</p>
      ) : (
        <div className="mt-4 grid md:grid-cols-5 gap-2 text-[11px]">
          <WalletStat label="Check in" value={today ? new Date(today.checkInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'} />
          <WalletStat label="Check out" value={today?.checkOutAt ? new Date(today.checkOutAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'} />
          <WalletStat label="Worked" value={minutesText(today?.totalWorkMinutes || 0)} />
          <WalletStat label="Late" value={minutesText(today?.lateMinutes || 0)} tone={today?.lateMinutes ? 'text-red-400' : 'text-green-400'} />
          <WalletStat label="Penalty" value={money(today?.penaltyAmount || 0)} tone={today?.penaltyAmount ? 'text-red-400' : 'text-green-400'} />
        </div>
      )}

      {today?.trustStatus && today.trustStatus !== 'TRUSTED' && (
        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-[11px] text-amber-200">
          <p className="font-bold">Attendance marked for review</p>
          <p className="mt-1 text-amber-100/80">{today.suspiciousReasons.map(labelSecurityReason).join(', ') || 'Additional verification may be requested.'}</p>
          {today.verificationRequired && today.selfieCount === 0 && !today.faceVerified && (
            <Button size="xs" variant="secondary" className="mt-3" onClick={() => setVerifyRecord(today)}>Quick verification</Button>
          )}
          {today.faceVerified && (
            <p className="mt-2 text-green-300/90">Face verified at check-in{today.faceVerifiedAt ? ` · ${new Date(today.faceVerifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
          )}
        </div>
      )}

      {today && today.penaltyAmount > 0 && (
        <PenaltyAppealStatus
          penaltyAmount={today.penaltyAmount}
          lateMinutes={today.lateMinutes}
          waivers={today.waiverRequests || []}
          onRequestReview={() => setAppealOpen(true)}
          onCancelPending={id => void cancelAppeal(id)}
          cancelling={busy === 'cancel'}
        />
      )}

      <PenaltyAppealModal
        open={appealOpen}
        businessId={businessId}
        target={
          today && today.penaltyAmount > 0
            ? {
                attendanceRecordId: today.id,
                penaltyAmount: today.penaltyAmount,
                lateMinutes: today.lateMinutes,
                attendanceDate: today.attendanceDate,
              }
            : null
        }
        onClose={() => setAppealOpen(false)}
        onSubmitted={onRefresh}
      />

      {attendance && (
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          <WalletStat label="Month present" value={`${attendance.summary.presentDays} days`} />
          <WalletStat label="Month late" value={`${attendance.summary.lateCount} days`} tone="text-amber-300" />
          <WalletStat label="Total penalties" value={money(attendance.summary.totalPenalties)} tone="text-red-400" />
          <WalletStat label="Waived" value={money(attendance.summary.waivedPenalties)} tone="text-green-400" />
        </div>
      )}
      {verifyRecord && (
        <SelfieVerificationModal
          businessId={businessId}
          record={verifyRecord}
          onClose={() => setVerifyRecord(null)}
          onDone={() => {
            setVerifyRecord(null)
            onRefresh()
          }}
        />
      )}
      <FaceVerificationCheckIn
        businessId={businessId}
        open={faceCheckInOpen}
        onClose={() => setFaceCheckInOpen(false)}
        onSuccess={onRefresh}
      />
    </Card>
  )
}

function labelSecurityReason(reason: string) {
  if (reason === 'NEW_DEVICE') return 'new device'
  if (reason === 'FREQUENT_DEVICE_CHANGES') return 'frequent device changes'
  if (reason === 'LOCATION_MISMATCH') return 'away from office area'
  if (reason === 'LOCATION_CHANGED') return 'different location'
  if (reason === 'ADMIN_REQUEST') return 'admin requested verification'
  return reason.toLowerCase().replace(/_/g, ' ')
}

async function attendanceMetadata() {
  const sessionId = stableSessionId()
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }
  const screenText = typeof screen !== 'undefined' ? `${screen.width}x${screen.height}x${screen.colorDepth}` : ''
  const fingerprint = [
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    nav.userAgentData?.platform || navigator.platform,
    screenText,
  ].join('|')
  return {
    browserFingerprint: fingerprint,
    sessionId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    platform: nav.userAgentData?.platform || navigator.platform,
    screen: screenText,
    location: await quietLocation(),
  }
}

function stableSessionId() {
  const key = 'alma-attendance-session-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const id = crypto.randomUUID()
  window.localStorage.setItem(key, id)
  return id
}

async function quietLocation(): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  if (!navigator.geolocation) return null
  try {
    const permissions = navigator.permissions ? await navigator.permissions.query({ name: 'geolocation' as PermissionName }) : null
    if (permissions && permissions.state !== 'granted') return null
  } catch {
    return null
  }
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 1200 },
    )
  })
}

function SelfieVerificationModal({
  businessId,
  record,
  onClose,
  onDone,
}: {
  businessId: string
  record: AttendanceRecordDto
  onClose: () => void
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function upload(file: File) {
    setBusy(true)
    try {
      const imageDataUrl = await compressImage(file)
      const res = await fetch('/api/attendance/selfies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          attendance_record_id: record.id,
          image_data_url: imageDataUrl,
          content_type: 'image/jpeg',
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || 'Could not upload selfie')
      toast.success('Verification saved')
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex items-end sm:items-center justify-center bg-black/75 p-4">
      <Card className="w-full max-w-sm p-5 border-gold-dim/30">
        <p className="text-sm font-bold text-cream">Quick verification required</p>
        <p className="mt-2 text-xs text-zinc-500">This only happens for a new device, unusual location, or an admin request. Attendance is already recorded.</p>
        <label className="mt-4 block">
          <input
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            disabled={busy}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) void upload(file)
            }}
          />
          <span className="block cursor-pointer rounded-2xl bg-gold px-4 py-3 text-center text-sm font-black text-black">
            {busy ? 'Uploading...' : 'Take quick selfie'}
          </span>
        </label>
        <Button variant="ghost" className="mt-3 w-full justify-center" disabled={busy} onClick={onClose}>Later</Button>
      </Card>
    </div>
  )
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const max = 480
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Could not process selfie'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.55))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read selfie'))
    }
    img.src = url
  })
}

function WalletOverviewCard({ loading, wallet }: { loading: boolean; wallet: EmployeeWalletResponse | null }) {
  const s = wallet?.summary
  return (
    <Card className="p-5 border-gold-dim/25 bg-[#0c0c10]">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold mb-4">Employee wallet</p>
      {loading ? <Skeleton className="h-40 w-full" /> : !s ? (
        <Empty icon="◇" title="Wallet not active" desc="Link your HR employee ID to view salary balance." />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <WalletStat label="Current balance" value={money(s.currentBalance)} tone="text-green-400" />
          <WalletStat label="Withdrawable" value={money(s.availableWithdrawable)} tone="text-gold-lt" />
          <WalletStat label="Salary earned" value={money(s.totalAccrued)} />
          <WalletStat label="Commission" value={money(s.totalCommissions)} tone="text-green-400" />
          <WalletStat label="Eid bonus" value={money(s.totalEidBonuses)} />
          <WalletStat label="Overtime" value={money(s.totalOvertime)} />
          <WalletStat label="Penalties" value={money(s.totalPenalties)} tone="text-red-400" />
          <WalletStat label="Meal deductions" value={money(s.totalMealDeductions)} tone="text-red-400" />
          <WalletStat label="Advances" value={money(s.totalAdvances)} tone="text-amber-300" />
          <WalletStat label="Withdrawals" value={money(s.totalWithdrawals)} tone="text-zinc-300" />
        </div>
      )}
    </Card>
  )
}

function WalletStat({ label, value, tone = 'text-cream' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-black/25 p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-zinc-600">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold ${tone}`}>{value}</p>
    </div>
  )
}

function WalletRequestCard({
  businessId,
  empLinked,
  onSubmitted,
}: {
  businessId: string
  empLinked: boolean
  onSubmitted: () => void
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [type, setType] = useState<'WITHDRAWAL' | 'ADVANCE'>('WITHDRAWAL')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const amt = Number(amount)
    const r = reason.trim()
    if (!amt || amt <= 0 || !r) {
      toast.error('Amount and reason required')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/wallet/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: amt, reason: r, business_id: businessId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(j.error || 'Request failed')
        return
      }
      toast.success(`${type === 'WITHDRAWAL' ? 'Withdrawal' : 'Advance'} requested — awaiting approval`)
      setAmount('')
      setReason('')
      onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-gold-dim/20">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Wallet requests</p>
      <form onSubmit={submit} className="space-y-3 text-[11px]">
        <div className="grid grid-cols-2 gap-2">
          {(['WITHDRAWAL', 'ADVANCE'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${type === t ? 'border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border-border bg-card text-zinc-400 hover:text-cream'}`}
            >
              {t === 'WITHDRAWAL' ? 'Request withdrawal' : 'Request advance'}
            </button>
          ))}
        </div>
        <label className="block space-y-1">
          <span className="text-zinc-500">Amount (৳)</span>
          <Input value={amount} onChange={e => setAmount(e.target.value)} type="number" min={1} step="1" className="font-mono" disabled={!empLinked} />
        </label>
        <label className="block space-y-1">
          <span className="text-zinc-500">Reason</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} disabled={!empLinked} className="w-full rounded-xl bg-card border border-border px-3 py-2 text-cream text-sm resize-none disabled:opacity-40" />
        </label>
        <Button variant="gold" type="submit" className="w-full justify-center" disabled={busy || !empLinked}>{busy ? 'Sending…' : 'Submit request'}</Button>
      </form>
      {!empLinked && <p className="text-[11px] text-amber-400">Ask an admin to link your HR employee ID before requesting wallet movements.</p>}
    </Card>
  )
}

function RequestList({ requests }: { requests: WalletRequestDto[] }) {
  if (!requests.length) return <p className="text-[11px] text-zinc-600">No wallet requests yet.</p>
  return (
    <ul className="space-y-1.5 max-h-44 overflow-y-auto text-[11px]">
      {requests.slice(0, 20).map(r => (
        <li key={r.id} className="flex justify-between gap-2 border-b border-border/50 pb-1.5">
          <span className="text-zinc-500 font-mono">{r.createdAt.slice(0, 10)}</span>
          <span className="text-cream flex-1">{r.type.replace(/_/g, ' ')} · {money(r.requestedAmount)}</span>
          <span className={r.status === 'PENDING' ? 'text-amber-400' : r.status.includes('APPROVED') ? 'text-green-400' : 'text-red-400'}>{r.status.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ul>
  )
}

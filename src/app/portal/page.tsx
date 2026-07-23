'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { motion } from 'framer-motion'
import { FinancePageChrome } from '@/components/finance/FinancePageChrome'
import { Button, Card, Empty, Input, Skeleton } from '@/components/ui'
import { useBusiness } from '@/contexts/BusinessContext'
import { isSystemOwner, normalizeAlmaRole } from '@/lib/roles'
import { roundMoney } from '@/lib/money'
import type { EmployeeWalletResponse, WalletRequestDto } from '@/types/payroll-wallet'
import { FaceVerificationCheckIn } from '@/components/attendance/FaceVerificationCheckIn'
import { needsSelfieVerification, SelfieVerificationModal } from '@/components/attendance/SelfieVerificationModal'
import { PenaltyAppealModal } from '@/components/attendance/PenaltyAppealModal'
import { PenaltyAppealStatus } from '@/components/attendance/PenaltyAppealStatus'
import { ProfilePhotoSection } from '@/components/profile/ProfilePhotoSection'
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { safeFetchJson, safeFetchJsonWithToast } from '@/lib/safe-fetch'
import { useRegisterMobileRefresh } from '@/hooks/useRegisterMobileRefresh'
import { useMyDeskProfile } from '@/hooks/useMyDeskProfile'
import { useMyAttendance } from '@/hooks/useMyAttendance'
import { requireHighAccuracyLocation } from '@/lib/attendance-gps'
import { attendanceErrorLabel } from '@/lib/attendance-client'
import { OperationalTaskHero } from '@/components/operations/OperationalTaskHero'
import { OperationalTaskDock } from '@/components/operations/OperationalTaskDock'
import { useOperationalSpotlightTrigger } from '@/components/operations/useOperationalSpotlightTrigger'
import { invalidateOperationalTasksCache } from '@/hooks/useOperationalTasks'
import type { MyAttendancePayload } from '@/lib/attendance-client'
import type { AttendanceClientError } from '@/lib/attendance-errors'
import {
  AttendanceSubsectionBoundary,
  AttendanceWidgetErrorBoundary,
} from '@/components/runtime/AttendanceWidgetErrorBoundary'
import {
  asStringArray,
  ATTENDANCE_PAYLOAD_VERSION,
  clearAttendancePortalCache,
  formatAttendanceTime,
  normalizeMyAttendancePayload,
} from '@/lib/attendance-portal-normalize'
import { MySalarySlipCard } from '@/components/portal/MySalarySlipCard'
import { OfficeAdvanceDeskCard } from '@/components/portal/OfficeAdvanceDeskCard'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

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

type MealEligibility = {
  enabled: boolean
  amountBdt: number | null
  canRequestToday: boolean
  pendingRequest: { status: string; amountBdt: number | string } | null
  reason: string
}

type DrivingStatus = {
  enabled: boolean
  activeSession: { id: string; startedAt: string } | null
  pendingSession: { id: string } | null
  canStart: boolean
  reason: string
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

export default function EmployeePortalPage() {
  const { data: session } = useSession()
  const { business } = useBusiness()
  const role = normalizeAlmaRole(session?.user?.role)
  const systemOwner = isSystemOwner(session)

  const { profile: me, loading: loadingMe, employeeId: empId, refetch: refetchProfile } = useMyDeskProfile(business.id)
  const [wallet, setWallet] = useState<EmployeeWalletResponse | null>(null)
  const [walletLoading, setWalletLoading] = useState(true)
  const [mealEligibility, setMealEligibility] = useState<MealEligibility | null>(null)
  const [mealEligibilityLoading, setMealEligibilityLoading] = useState(true)
  const [drivingStatus, setDrivingStatus] = useState<DrivingStatus | null>(null)
  const [drivingLoading, setDrivingLoading] = useState(true)

  const attendanceEnabled = !systemOwner && Boolean(empId)
  const {
    attendance,
    loading: attendanceLoading,
    error: attendanceError,
    refetch: refetchAttendance,
  } = useMyAttendance(business.id, empId, attendanceEnabled)

  const profileIdentity = useMemo((): MeUser | null => {
    if (me) return me
    if (!session?.user?.id) return null
    return {
      id: session.user.id,
      email: session.user.email || '',
      name: session.user.name || 'Account',
      phone: null,
      role,
      businessAccess: '',
      employeeIdGas: null,
      joiningDate: null,
      salaryHint: null,
      profileImageUrl: null,
    }
  }, [me, role, session?.user?.email, session?.user?.id, session?.user?.name])

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
      const result = await safeFetchJson<EmployeeWalletResponse>(
        `/api/payroll/wallet/${encodeURIComponent(empId)}?business_id=${business.id}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setWallet(result.data)
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

  const loadMealEligibility = useCallback(async () => {
    if (systemOwner) {
      setMealEligibility(null)
      setMealEligibilityLoading(false)
      return
    }
    setMealEligibilityLoading(true)
    try {
      const result = await safeFetchJson<MealEligibility>(
        `/api/payroll/meal-allowance/eligibility?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setMealEligibility(result.data)
    } catch (e) {
      setMealEligibility(null)
      toast.error((e as Error).message || 'Could not load meal allowance status')
    } finally {
      setMealEligibilityLoading(false)
    }
  }, [business.id, systemOwner])

  useEffect(() => {
    void loadMealEligibility()
  }, [loadMealEligibility])

  const loadDrivingStatus = useCallback(async () => {
    if (systemOwner) {
      setDrivingStatus(null)
      setDrivingLoading(false)
      return
    }
    setDrivingLoading(true)
    try {
      const result = await safeFetchJson<DrivingStatus>(
        `/api/payroll/driving-mode/status?business_id=${encodeURIComponent(business.id)}`,
        { cache: 'no-store' },
      )
      if (!result.ok) throw new Error(result.error.message)
      setDrivingStatus(result.data)
    } catch {
      setDrivingStatus(null)
    } finally {
      setDrivingLoading(false)
    }
  }, [business.id, systemOwner])

  useEffect(() => {
    void loadDrivingStatus()
  }, [loadDrivingStatus])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadWallet()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadWallet])

  useEffect(() => {
    if (systemOwner || !empId) return
    clearAttendancePortalCache(business.id, empId)
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('alma_attendance_me_v') && !key.includes(`_v${ATTENDANCE_PAYLOAD_VERSION}_`)) {
          localStorage.removeItem(key)
        }
      }
    } catch {
      // ignore
    }
  }, [business.id, empId, systemOwner])

  useRegisterMobileRefresh(
    useCallback(async () => {
      await refetchProfile()
      await loadWallet()
      await loadMealEligibility()
      await refetchAttendance({ clearCache: true })
    }, [refetchProfile, loadWallet, loadMealEligibility, refetchAttendance]),
    !systemOwner,
  )

  const refreshDesk = useCallback(async () => {
    await refetchProfile()
    await loadWallet()
    await loadMealEligibility()
    await refetchAttendance()
  }, [refetchProfile, loadWallet, loadMealEligibility, refetchAttendance])

  const hasCheckedInToday = Boolean(attendance?.today?.checkInAt)
  const opsSpotlight = useOperationalSpotlightTrigger(business.id, !systemOwner, {
    hasCheckedInToday,
    employeeIdGas: empId,
  })
  const {
    triggerAfterCheckIn: triggerOpsAfterCheckIn,
    refetch: refetchOpsTasks,
    minimizeHero: minimizeOpsHero,
    handleUpdated: handleOpsUpdated,
    openHero: openOpsHero,
    spotlight: opsSpotlightAssignment,
    heroOpen: opsHeroOpen,
    openTasks: opsOpenTasks,
    primaryTask: opsPrimaryTask,
  } = opsSpotlight

  const handleProfileUpdated = useCallback(() => {
    void refetchProfile()
  }, [refetchProfile])

  const handleAttendanceRetry = useCallback(() => {
    if (empId) clearAttendancePortalCache(business.id, empId)
    void refetchAttendance({ clearCache: true })
  }, [business.id, empId, refetchAttendance])

  const handleAttendanceRefresh = useCallback(() => {
    if (empId) clearAttendancePortalCache(business.id, empId)
    void refetchAttendance({ clearCache: true })
    void refreshDesk()
  }, [business.id, empId, refetchAttendance, refreshDesk])

  const handleAttendanceEndWork = useCallback(() => {
    invalidateOperationalTasksCache(business.id)
    void refetchOpsTasks(true)
  }, [business.id, refetchOpsTasks])

  const ordersHref = business.id === 'CREATIVE_DIGITAL_IT' ? '/digital/projects' : '/orders/new'

  return (
    <div className="min-h-[100dvh] bg-transparent">
      {!systemOwner && empId && (
        <>
          <OperationalTaskHero
            businessId={business.id}
            assignment={opsSpotlightAssignment}
            open={opsHeroOpen}
            onMinimize={minimizeOpsHero}
            onUpdated={handleOpsUpdated}
          />
          <OperationalTaskDock
            businessId={business.id}
            tasks={opsOpenTasks}
            primary={opsPrimaryTask}
            heroOpen={opsHeroOpen}
            onReopen={openOpsHero}
            onUpdated={handleOpsUpdated}
          />
        </>
      )}
    <FinancePageChrome
      title="My desk"
      subtitle="Wallet balance · withdrawal requests · payroll history"
      hideDateFilter
      actions={(
        <div className="flex gap-2 flex-wrap justify-end">
          <Link href={ordersHref}>
            <Button size="xs" variant="gold">{business.id === 'CREATIVE_DIGITAL_IT' ? 'Projects' : 'New order'}</Button>
          </Link>
          <Link href="/invoice"><Button size="xs" variant="secondary">Invoices</Button></Link>
        </div>
      )}
    >
      <motion.div variants={stagger} initial="hidden" animate="show">
      {!systemOwner && (
        <AdvanceRecoveryNotice
          wallet={wallet}
          businessId={business.id}
          onAck={() => void loadWallet()}
        />
      )}
      {profileIdentity && (
        <motion.div variants={fadeUp} className="mb-4 min-h-[208px]">
          {loadingMe && !me ? (
            <Skeleton className="h-52 w-full rounded-2xl" />
          ) : (
            <ProfilePhotoSection
              userId={profileIdentity.id}
              name={profileIdentity.name}
              email={profileIdentity.email}
              imageUrl={me?.profileImageUrl ?? profileIdentity.profileImageUrl}
              onUpdated={handleProfileUpdated}
            />
          )}
        </motion.div>
      )}

      <motion.div variants={fadeUp}>
      <div className="grid md:grid-cols-2 gap-4">
        {systemOwner ? (
          <SystemOwnerCard businessName={business.name} />
        ) : (
          <AttendanceWidgetErrorBoundary
            section="portal_attendance"
            userId={session?.user?.id}
            businessId={business.id}
            employeeId={empId ?? undefined}
            onRetry={handleAttendanceRetry}
          >
            <AttendanceCard
              businessId={business.id}
              empLinked={Boolean(empId)}
              loading={attendanceLoading}
              attendance={attendance}
              attendanceError={attendanceError}
              onRefresh={handleAttendanceRefresh}
              onCheckInSuccess={triggerOpsAfterCheckIn}
              onEndWork={handleAttendanceEndWork}
            />
          </AttendanceWidgetErrorBoundary>
        )}

        <Card className="p-5 space-y-3 border-gold-dim/25 bg-card/78">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Account details</p>
          {loadingMe ? <Skeleton className="h-28 w-full" /> : !me ? (
            <div>
            <Empty icon="◇" title="Could not load full profile" desc="Your photo is saved above. Retry to load payroll and HR details for this business." />
            <div className="mt-3">
              <Button size="xs" variant="secondary" onClick={() => void refetchProfile()}>Retry profile</Button>
            </div>
            </div>
          ) : (
            <>
            <dl className="grid gap-2 text-[11px]">
              <div className="flex justify-between gap-3"><dt className="text-muted">Name</dt><dd className="text-cream font-medium">{me.name}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Email</dt><dd className="font-mono text-muted truncate max-w-[55%]" title={me.email}>{me.email}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Role</dt><dd className="text-gold-lt">{role.replace(/_/g, ' ')}</dd></div>
              {me.profile?.roleTitle && <div className="flex justify-between gap-3"><dt className="text-muted">Profile role</dt><dd className="text-muted">{me.profile.roleTitle}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Business scope</dt><dd className="text-muted text-right">{me.businessAccess.replace(/,/g, ', ')}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">HR employee ID</dt><dd className="font-mono text-muted">{systemOwner ? 'System owner - not required' : me.employeeIdGas || '— link in Users'}</dd></div>
              {me.profile?.shift && <div className="flex justify-between gap-3"><dt className="text-muted">Shift</dt><dd className="text-muted">{me.profile.shift}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-muted">Salary hint</dt><dd className="font-mono text-gold">
                {me.salaryHint != null ? `৳ ${Number(me.salaryHint).toLocaleString('en-BD')}` : '—'}
              </dd></div>
            </dl>
            </>
          )}
        </Card>

        {!systemOwner && (
          <Card className="p-5 border-gold-dim/20 bg-card/78 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Payout identity</p>
              <p className="mt-1 text-[11px] text-muted">bKash, Nagad, Rocket, or bank — used when wallet requests are approved.</p>
            </div>
            <Link href="/portal/payment-accounts">
              <Button size="sm" variant="gold">Payment accounts</Button>
            </Link>
          </Card>
        )}

        {!systemOwner && (
          <Card className="p-5 border-gold-dim/20 bg-card/78 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">নিজ খরচ ফেরত</p>
              <p className="mt-1 text-[11px] text-muted">নিজের পকেট থেকে অফিসের খরচ করেছেন? ফেরতের আবেদন করুন — মালিক অনুমোদন করলে ওয়ালেটে যোগ হবে।</p>
            </div>
            <Link href="/portal/expense">
              <Button size="sm" variant="gold">খরচ ফেরত চান</Button>
            </Link>
          </Card>
        )}

        {!systemOwner && (role === 'ADMIN' || role === 'SUPER_ADMIN') && (
          <OfficeAdvanceDeskCard businessId={business.id} />
        )}

        {!systemOwner && (
          <div className="min-h-[180px]">
            <WalletOverviewCard loading={walletLoading} wallet={wallet} />
          </div>
        )}

        {!systemOwner && (
          <MySalarySlipCard
            empLinked={Boolean(empId)}
            employeeId={empId}
            profile={me}
            sessionRole={role}
            wallet={wallet}
            walletLoading={walletLoading}
          />
        )}

        {!systemOwner && (
          <WalletRequestCard
            businessId={business.id}
            empLinked={Boolean(empId)}
            availableWithdrawable={Number(wallet?.summary?.availableWithdrawable ?? 0)}
            onSubmitted={() => {
              void loadWallet()
              void refetchProfile()
            }}
          />
        )}

        {!systemOwner && (
          <div className="min-h-[120px]">
            <MealAllowanceCard
              businessId={business.id}
              empLinked={Boolean(empId)}
              loading={mealEligibilityLoading}
              eligibility={mealEligibility}
              onSubmitted={() => void loadMealEligibility()}
            />
          </div>
        )}

        {!systemOwner && drivingStatus?.enabled && (
          <div className="min-h-[120px]">
            <DrivingModeCard
              businessId={business.id}
              empLinked={Boolean(empId)}
              loading={drivingLoading}
              status={drivingStatus}
              onChanged={() => void loadDrivingStatus()}
            />
          </div>
        )}

        {!systemOwner && <Card className="p-5 md:col-span-2">
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-sm font-bold text-cream">Wallet transaction history</p>
            {empId && <Link href="/portal/wallet" className="text-[11px] font-bold text-gold-lt hover:text-gold">সম্পূর্ণ হিসাব →</Link>}
          </div>
          {!empId ? (
            <p className="text-[11px] text-muted">Link your HR employee ID (Users settings) to activate the payroll wallet.</p>
          ) : walletLoading ? (
            <Skeleton className="h-36 w-full" />
          ) : !(wallet?.entries ?? []).length ? (
            <p className="text-[11px] text-muted">No wallet entries yet. HR can run monthly salary accruals from Payroll.</p>
          ) : (
            <div className="divide-y divide-border max-h-56 overflow-y-auto text-[11px]">
              {(wallet!.entries ?? []).slice().reverse().slice(0, 60).map(tx => (
                <div key={String(tx.id ?? `${tx.date}-${tx.type}`)} className="py-2 grid grid-cols-[82px_1fr_auto_auto] gap-2 items-center">
                  <span className="text-muted font-mono">{String(tx.date).slice(0, 10)}</span>
                  <span className="text-cream">{walletTxLabel(tx)}</span>
                  <span className={tx.signedAmount >= 0 ? 'font-mono text-green-400' : 'font-mono text-red-400'}>
                    {tx.signedAmount >= 0 ? '+' : '-'}৳ {Math.abs(tx.signedAmount).toLocaleString('en-BD')}
                  </span>
                  <span className="font-mono text-gold-lt">৳ {tx.runningBalance.toLocaleString('en-BD')}</span>
                </div>
              ))}
            </div>
          )}
        </Card>}

        {!systemOwner && <Card className="p-5 md:col-span-2 bg-white/[0.04] border-border">
          <p className="text-sm font-bold text-cream mb-2">Pending requests</p>
          <RequestList requests={wallet?.requests ?? []} />
        </Card>}
      </div>
      </motion.div>
      </motion.div>

    </FinancePageChrome>
    </div>
  )
}

function money(n: unknown) {
  return `৳ ${Number(n || 0).toLocaleString('en-BD')}`
}

// Human label for a wallet transaction. Attendance fines all post as PENALTY,
// so we read the ledger `source` to tell late check-in vs early checkout vs
// no-checkout apart (and label the two refund kinds).
const WALLET_SOURCE_LABEL: Record<string, string> = {
  attendance_late_penalty: 'দেরিতে আসার জরিমানা',
  attendance_early_leave_penalty: 'আগে বের হওয়ার জরিমানা',
  attendance_no_checkout_fine: 'চেক-আউট না করার জরিমানা',
  attendance_late_penalty_reversal: 'জরিমানা ফেরত (আপিল)',
  attendance_exception_refund: 'জরিমানা ফেরত (অনুমতি)',
}

function walletTxLabel(tx: { type: string; source?: string | null }) {
  const bySource = tx.source ? WALLET_SOURCE_LABEL[tx.source] : undefined
  return bySource ?? tx.type.replace(/_/g, ' ')
}

function SystemOwnerCard({ businessName }: { businessName: string }) {
  return (
    <Card className="p-5 md:col-span-2 border-gold-dim/30 bg-gradient-to-br from-gold/10 via-card to-white/80">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">System owner mode</p>
      <h2 className="mt-2 text-xl font-black text-cream">Owner control active</h2>
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
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

const LEAVE_KIND_LABEL: Record<string, string> = {
  FULL_DAY: 'একদিন',
  DATE_RANGE: 'কয়েকদিন',
  HOURS: 'কয়েক ঘণ্টা',
  SHIFTED_START: 'দেরিতে শুরু',
}

const LEAVE_STATUS_LABEL: Record<string, string> = {
  PENDING: '⏳ অপেক্ষমাণ',
  APPROVED: '✅ অনুমোদিত',
  REJECTED: '❌ প্রত্যাখ্যাত',
  CANCELLED: 'বাতিল',
}

/** Minutes-since-midnight → "2:00 PM" (for hourly / shifted-start leave display). */
function minutesToClock(m: number): string {
  const h = Math.floor(m / 60), mm = m % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`
}

function AttendanceCard({
  businessId,
  empLinked,
  loading,
  attendance,
  attendanceError,
  onRefresh,
  onCheckInSuccess,
  onEndWork,
}: {
  businessId: string
  empLinked: boolean
  loading: boolean
  attendance: MyAttendancePayload | null
  attendanceError: AttendanceClientError | null
  onRefresh: () => void
  onCheckInSuccess?: () => void | Promise<void>
  onEndWork?: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<'out' | 'cancel' | 'exception' | 'leave' | null>(null)
  const [appealOpen, setAppealOpen] = useState(false)
  const [verifyRecord, setVerifyRecord] = useState<AttendanceRecordDto | null>(null)
  const [faceCheckInOpen, setFaceCheckInOpen] = useState(false)
  const [exceptionOpen, setExceptionOpen] = useState(false)
  const [exceptionReason, setExceptionReason] = useState('')
  const [exceptionScope, setExceptionScope] = useState<'EARLY_CHECKOUT' | 'LATE_ARRIVAL' | 'FULL_DAY'>('EARLY_CHECKOUT')
  const [exceptionStatus, setExceptionStatus] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leaveKind, setLeaveKind] = useState<'FULL_DAY' | 'DATE_RANGE' | 'HOURS' | 'SHIFTED_START'>('FULL_DAY')
  const [leaveStartDate, setLeaveStartDate] = useState('')
  const [leaveEndDate, setLeaveEndDate] = useState('')
  const [leaveStartTime, setLeaveStartTime] = useState('')
  const [leaveEndTime, setLeaveEndTime] = useState('')
  const [leaveReason, setLeaveReason] = useState('')
  const [leaveList, setLeaveList] = useState<Array<{ id: string; kind: string; status: string; startDate: string; endDate: string; startMinutes?: number | null; endMinutes?: number | null }>>([])
  const desk = useMemo(
    () => (attendance ? normalizeMyAttendancePayload(attendance) : null),
    [attendance],
  )
  const today = desk?.today ?? null
  const summary = desk?.summary ?? {
    presentDays: 0,
    lateCount: 0,
    totalPenalties: 0,
    waivedPenalties: 0,
    averageWorkMinutes: 0,
  }
  const waiverList = Array.isArray(today?.waiverRequests) ? today.waiverRequests : []
  const securityReasons = asStringArray(today?.suspiciousReasons)
  const penaltyAmount = Number(today?.penaltyAmount ?? 0)
  const selfieActionRequired = needsSelfieVerification(today)
  const selfieSubmitted = Boolean(today && today.selfieCount > 0 && !today.verificationRequired)

  useEffect(() => {
    if (!selfieActionRequired) return
    const timer = window.setInterval(() => {
      if (!document.hidden) void onRefresh()
    }, 20_000)
    return () => window.clearInterval(timer)
  }, [selfieActionRequired, onRefresh])

  async function postCheckOut() {
    setBusy('out')
    try {
      // Capture GPS so the server can enforce the office geofence on checkout
      // (same as check-in). Failures fall back to null location; the server
      // decides whether that blocks based on the active rules.
      const metadata = await attendanceMetadata().catch(() => undefined)
      const result = await safeFetchJsonWithToast('/api/attendance/check-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, metadata }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Work ended')
      onEndWork?.()
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Step 3 — load today's exception status so the staff sees pending/approved.
  useEffect(() => {
    if (!empLinked || !businessId) return
    let cancelled = false
    void (async () => {
      const result = await safeFetchJson(
        `/api/attendance/exceptions?business_id=${encodeURIComponent(businessId)}`,
      )
      if (!cancelled && result.ok) {
        const ex = (result.data as { exception?: { status?: string } | null })?.exception
        setExceptionStatus(ex?.status ?? null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [empLinked, businessId, today?.checkInAt, today?.checkOutAt])

  async function requestException() {
    const reason = exceptionReason.trim()
    if (reason.length < 3) {
      toast.error('সংক্ষেপে কারণ লিখুন (অন্তত ৩ অক্ষর)।')
      return
    }
    setBusy('exception')
    try {
      const result = await safeFetchJsonWithToast('/api/attendance/exceptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, reason, scope: exceptionScope }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('অনুমতির অনুরোধ মালিকের কাছে পাঠানো হয়েছে।')
      setExceptionStatus('PENDING')
      setExceptionReason('')
      setExceptionScope('EARLY_CHECKOUT')
      setExceptionOpen(false)
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Step 4 — load the staff's recent leave applications (status display).
  useEffect(() => {
    if (!empLinked || !businessId) return
    let cancelled = false
    void (async () => {
      const result = await safeFetchJson(
        `/api/attendance/leave?business_id=${encodeURIComponent(businessId)}`,
      )
      if (!cancelled && result.ok) {
        const rows = (result.data as { leaves?: typeof leaveList })?.leaves
        setLeaveList(Array.isArray(rows) ? rows : [])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [empLinked, businessId, today?.checkInAt, today?.checkOutAt])

  function timeToMinutes(value: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }

  async function requestLeave() {
    if (!leaveStartDate) {
      toast.error('ছুটির শুরুর তারিখ দিন।')
      return
    }
    if (leaveReason.trim().length < 3) {
      toast.error('ছুটির কারণ লিখুন (অন্তত ৩ অক্ষর)।')
      return
    }
    const startMinutes = (leaveKind === 'HOURS' || leaveKind === 'SHIFTED_START')
      ? timeToMinutes(leaveStartTime)
      : null
    const endMinutes = leaveKind === 'HOURS' ? timeToMinutes(leaveEndTime) : null
    if ((leaveKind === 'HOURS' || leaveKind === 'SHIFTED_START') && startMinutes == null) {
      toast.error('সময় (ঘণ্টা) সঠিকভাবে দিন।')
      return
    }
    if (leaveKind === 'HOURS' && (endMinutes == null || (startMinutes != null && endMinutes <= startMinutes))) {
      toast.error('ছুটির শুরু ও শেষ সময় ঠিকভাবে দিন।')
      return
    }
    setBusy('leave')
    try {
      const result = await safeFetchJsonWithToast('/api/attendance/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: businessId,
          kind: leaveKind,
          start_date: leaveStartDate,
          end_date: leaveKind === 'DATE_RANGE' ? (leaveEndDate || leaveStartDate) : leaveStartDate,
          start_minutes: startMinutes,
          end_minutes: endMinutes,
          reason: leaveReason.trim(),
        }),
      })
      if (!result.ok) throw new Error(result.error.message)
      toast.success('ছুটির আবেদন মালিকের কাছে পাঠানো হয়েছে।')
      setLeaveOpen(false)
      setLeaveReason('')
      setLeaveStartDate('')
      setLeaveEndDate('')
      setLeaveStartTime('')
      setLeaveEndTime('')
      setLeaveKind('FULL_DAY')
      const refreshed = await safeFetchJson(
        `/api/attendance/leave?business_id=${encodeURIComponent(businessId)}`,
      )
      if (refreshed.ok) {
        const rows = (refreshed.data as { leaves?: typeof leaveList })?.leaves
        setLeaveList(Array.isArray(rows) ? rows : [])
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function cancelAppeal(waiverId: string) {
    setBusy('cancel')
    try {
      const result = await safeFetchJsonWithToast(
        `/api/attendance/waivers/${waiverId}?business_id=${encodeURIComponent(businessId)}`,
        { method: 'DELETE' },
      )
      if (!result.ok) throw new Error(result.error.message)
      toast.success('Review request cancelled')
      onRefresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="p-5 md:col-span-2 border-gold-dim/30 bg-gradient-to-br from-gold/10 via-card to-white/80">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Today attendance</p>
          <h2 className="mt-2 text-xl font-black text-cream">{today ? (today.checkOutAt ? 'Workday completed' : 'Work is running') : 'Ready to start work'}</h2>
          <p className="mt-1 text-xs text-muted">Office time: 9:00 AM - 9:00 PM. Late penalties sync to your wallet automatically.</p>
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

      <AttendanceSubsectionBoundary name="Error banner">
        {attendanceError && (
          <div className="mt-4 rounded-xl border tone-red p-3 text-xs">
            <p className="font-bold">{attendanceErrorLabel(attendanceError.code)}</p>
            <p className="mt-1">{attendanceError.message}</p>
            {attendanceError.retryable && (
              <Button size="xs" variant="secondary" className="mt-3" onClick={onRefresh}>
                Retry attendance
              </Button>
            )}
          </div>
        )}
      </AttendanceSubsectionBoundary>

      <AttendanceSubsectionBoundary name="Daily stats">
        {loading ? <Skeleton className="mt-4 h-28 w-full" /> : !empLinked ? (
          <p className="mt-4 rounded-xl border tone-amber p-3 text-xs">Ask an admin to link your HR employee ID before using attendance.</p>
        ) : (
          <div className="mt-4 grid md:grid-cols-5 gap-2 text-[11px]">
            <WalletStat label="Check in" value={formatAttendanceTime(today?.checkInAt)} />
            <WalletStat label="Check out" value={formatAttendanceTime(today?.checkOutAt)} />
            <WalletStat label="Worked" value={minutesText(today?.totalWorkMinutes || 0)} />
            <WalletStat label="Late" value={minutesText(today?.lateMinutes || 0)} tone={today?.lateMinutes ? 'text-red-400' : 'text-green-400'} />
            <WalletStat label="Penalty" value={money(today?.penaltyAmount || 0)} tone={today?.penaltyAmount ? 'text-red-400' : 'text-green-400'} />
          </div>
        )}
      </AttendanceSubsectionBoundary>

      <AttendanceSubsectionBoundary name="Verification banner">
        {selfieActionRequired && (
          <div className="mt-4 rounded-2xl border-2 tone-amber p-4 shadow-lg shadow-amber-500/10">
            <p className="text-sm font-black">Verification required</p>
            <p className="mt-1 text-xs text-amber-600">
              Admin requested a quick face photo. Your check-in is saved — complete verification now.
            </p>
            <Button
              variant="gold"
              className="mt-4 h-[52px] w-full justify-center text-base font-black touch-manipulation min-h-[52px]"
              onClick={() => setVerifyRecord(today)}
            >
              📸 Verify Face Now
            </Button>
          </div>
        )}

        {today?.trustStatus && today.trustStatus !== 'TRUSTED' && !selfieActionRequired && (
          <div className="mt-4 rounded-2xl border tone-amber p-3 text-[11px]">
            <p className="font-bold">Attendance marked for review</p>
            <p className="mt-1 text-amber-600">{securityReasons.map(labelSecurityReason).join(', ') || 'Additional verification may be requested.'}</p>
            {selfieSubmitted && (
              <p className="mt-2 text-emerald-600">Verification submitted — waiting for admin review.</p>
            )}
            {today.faceVerified && (
              <p className="mt-2 text-emerald-600">Face verified at check-in{today.faceVerifiedAt ? ` · ${formatAttendanceTime(today.faceVerifiedAt)}` : ''}</p>
            )}
          </div>
        )}
      </AttendanceSubsectionBoundary>

      <AttendanceSubsectionBoundary name="Attendance exception">
        {empLinked && today && !today.checkOutAt && (
          <div className="mt-4 rounded-2xl border tone-amber p-3 text-[11px]">
            {exceptionStatus === 'APPROVED' ? (
              <p className="font-bold text-emerald-600">
                ✅ আজকের জন্য মালিক অনুমতি দিয়েছেন — নিয়ম মওকুফ, এখন স্বাভাবিকভাবে চেক-আউট করতে পারবেন।
              </p>
            ) : exceptionStatus === 'PENDING' ? (
              <p className="font-bold text-amber-600">
                ⏳ আপনার অনুমতির অনুরোধ মালিকের অনুমোদনের অপেক্ষায় আছে।
              </p>
            ) : (
              <>
                <p className="font-bold">আগে বের হতে / মাঠের কাজ / দেরিতে আসা?</p>
                <p className="mt-1 text-muted">
                  নিয়ম (সময়, লোকেশন, কাজ, জরিমানা) মওকুফ চাইলে মালিকের কাছে অনুমতি চান। অনুমোদন পেলে আজকের জন্য নিয়ম প্রযোজ্য হবে না।
                </p>
                {exceptionOpen ? (
                  <div className="mt-3 space-y-2">
                    <div>
                      <p className="mb-1 font-semibold text-[11px]">উদ্দেশ্য বেছে নিন:</p>
                      <div className="grid gap-1">
                        {([
                          ['EARLY_CHECKOUT', '🚶 আগে বের হবো / মাঠের কাজ'],
                          ['LATE_ARRIVAL', '⏰ দেরিতে এসেছি / আসবো'],
                          ['FULL_DAY', '📅 সারাদিন সব নিয়ম মওকুফ'],
                        ] as const).map(([value, label]) => (
                          <label
                            key={value}
                            className={`flex items-center gap-2 rounded-lg border p-2 text-[11px] cursor-pointer ${
                              exceptionScope === value ? 'border-gold tone-gold' : 'border-gold-dim/40'
                            }`}
                          >
                            <input
                              type="radio"
                              name="exceptionScope"
                              value={value}
                              checked={exceptionScope === value}
                              onChange={() => setExceptionScope(value)}
                              disabled={busy === 'exception'}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {exceptionScope === 'LATE_ARRIVAL' && (
                        <p className="mt-1 text-[10px] text-muted">
                          নোট: দেরিতে আসার অনুমতি দিয়ে আগে বের হওয়া যাবে না — সেজন্য আলাদা অনুমতি লাগবে।
                        </p>
                      )}
                    </div>
                    <textarea
                      className="w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                      rows={3}
                      placeholder="কারণ লিখুন (যেমন: মাঠে ডেলিভারিতে যাচ্ছি / জরুরি কাজ)"
                      value={exceptionReason}
                      onChange={e => setExceptionReason(e.target.value)}
                      disabled={busy === 'exception'}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="gold"
                        size="sm"
                        disabled={busy === 'exception'}
                        onClick={() => void requestException()}
                      >
                        {busy === 'exception' ? 'পাঠানো হচ্ছে...' : 'অনুমতি পাঠান'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy === 'exception'}
                        onClick={() => setExceptionOpen(false)}
                      >
                        বাতিল
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => setExceptionOpen(true)}
                  >
                    🙏 অনুমতি চাও
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </AttendanceSubsectionBoundary>

      <AttendanceSubsectionBoundary name="Leave application">
        {empLinked && (
          <div className="mt-4 rounded-2xl border tone-blue p-3 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <p className="font-bold">ছুটির আবেদন</p>
              {!leaveOpen && (
                <Button variant="secondary" size="sm" onClick={() => setLeaveOpen(true)}>
                  🏖️ ছুটি চাও
                </Button>
              )}
            </div>
            <p className="mt-1 text-muted">
              পুরো দিন, কয়েকদিন, কয়েক ঘণ্টা, বা দেরিতে শুরু — মালিক অনুমোদন করলে ঐ সময়ে কোনো জরিমানা হবে না।
            </p>

            {leaveOpen && (
              <div className="mt-3 space-y-2">
                <select
                  className="w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                  value={leaveKind}
                  onChange={e => setLeaveKind(e.target.value as typeof leaveKind)}
                  disabled={busy === 'leave'}
                >
                  <option value="FULL_DAY">একদিনের ছুটি</option>
                  <option value="DATE_RANGE">কয়েকদিনের ছুটি</option>
                  <option value="HOURS">কয়েক ঘণ্টার ছুটি</option>
                  <option value="SHIFTED_START">দেরিতে শুরু</option>
                </select>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-muted">শুরুর তারিখ</span>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                      value={leaveStartDate}
                      onChange={e => setLeaveStartDate(e.target.value)}
                      disabled={busy === 'leave'}
                    />
                  </label>
                  {leaveKind === 'DATE_RANGE' && (
                    <label className="block">
                      <span className="text-muted">শেষ তারিখ</span>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                        value={leaveEndDate}
                        onChange={e => setLeaveEndDate(e.target.value)}
                        disabled={busy === 'leave'}
                      />
                    </label>
                  )}
                </div>

                {(leaveKind === 'HOURS' || leaveKind === 'SHIFTED_START') && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-muted">{leaveKind === 'SHIFTED_START' ? 'কখন শুরু করবেন' : 'ছুটি শুরু'}</span>
                      <input
                        type="time"
                        className="mt-1 w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                        value={leaveStartTime}
                        onChange={e => setLeaveStartTime(e.target.value)}
                        disabled={busy === 'leave'}
                      />
                    </label>
                    {leaveKind === 'HOURS' && (
                      <label className="block">
                        <span className="text-muted">ছুটি শেষ</span>
                        <input
                          type="time"
                          className="mt-1 w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                          value={leaveEndTime}
                          onChange={e => setLeaveEndTime(e.target.value)}
                          disabled={busy === 'leave'}
                        />
                      </label>
                    )}
                  </div>
                )}

                <textarea
                  className="w-full rounded-lg border border-gold-dim/40 bg-white/80 p-2 text-xs text-cream"
                  rows={2}
                  placeholder="ছুটির কারণ লিখুন"
                  value={leaveReason}
                  onChange={e => setLeaveReason(e.target.value)}
                  disabled={busy === 'leave'}
                />

                <div className="flex gap-2">
                  <Button
                    variant="gold"
                    size="sm"
                    disabled={busy === 'leave'}
                    onClick={() => void requestLeave()}
                  >
                    {busy === 'leave' ? 'পাঠানো হচ্ছে...' : 'আবেদন পাঠান'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy === 'leave'}
                    onClick={() => setLeaveOpen(false)}
                  >
                    বাতিল
                  </Button>
                </div>
              </div>
            )}

            {leaveList.length > 0 && (
              <div className="mt-3 space-y-1">
                {leaveList.slice(0, 5).map(lv => (
                  <div key={lv.id} className="flex items-center justify-between gap-2 rounded-lg bg-white/40 px-2 py-1">
                    <span>
                      {lv.startDate.slice(0, 10)}
                      {lv.startDate.slice(0, 10) !== lv.endDate.slice(0, 10) ? ` – ${lv.endDate.slice(0, 10)}` : ''}
                      {' · '}{LEAVE_KIND_LABEL[lv.kind] || lv.kind}
                      {(lv.kind === 'HOURS' && lv.startMinutes != null && lv.endMinutes != null)
                        ? ` (${minutesToClock(lv.startMinutes)}–${minutesToClock(lv.endMinutes)})`
                        : (lv.kind === 'SHIFTED_START' && lv.startMinutes != null)
                          ? ` (${minutesToClock(lv.startMinutes)} থেকে)`
                          : ''}
                    </span>
                    <span className={
                      lv.status === 'APPROVED' ? 'font-bold text-emerald-600'
                        : lv.status === 'REJECTED' ? 'font-bold text-red-400'
                          : 'font-bold text-amber-600'
                    }>
                      {LEAVE_STATUS_LABEL[lv.status] || lv.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </AttendanceSubsectionBoundary>

      <AttendanceSubsectionBoundary name="Penalty appeals">
        {penaltyAmount > 0 && today && (
          <PenaltyAppealStatus
            penaltyAmount={penaltyAmount}
            lateMinutes={Number(today.lateMinutes || 0)}
            waivers={waiverList}
            onRequestReview={() => setAppealOpen(true)}
            onCancelPending={id => void cancelAppeal(id)}
            cancelling={busy === 'cancel'}
          />
        )}
      </AttendanceSubsectionBoundary>

      {appealOpen && (
        <PenaltyAppealModal
          open={appealOpen}
          businessId={businessId}
          target={
            today && penaltyAmount > 0
              ? {
                  attendanceRecordId: today.id,
                  penaltyAmount,
                  lateMinutes: Number(today.lateMinutes || 0),
                  attendanceDate: today.attendanceDate,
                }
              : null
          }
          onClose={() => setAppealOpen(false)}
          onSubmitted={onRefresh}
        />
      )}

      <AttendanceSubsectionBoundary name="Monthly summary">
        {desk && !desk.needsEmployeeLink && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
            <WalletStat label="Month present" value={`${summary.presentDays} days`} />
            <WalletStat label="Month late" value={`${summary.lateCount} days`} tone="text-amber-600" />
            <WalletStat label="Total penalties" value={money(summary.totalPenalties)} tone="text-red-400" />
            <WalletStat label="Waived" value={money(summary.waivedPenalties)} tone="text-green-400" />
          </div>
        )}
      </AttendanceSubsectionBoundary>

      {verifyRecord && (
        <SelfieVerificationModal
          businessId={businessId}
          attendanceRecordId={verifyRecord.id}
          open
          onClose={() => setVerifyRecord(null)}
          onSuccess={async () => {
            setVerifyRecord(null)
            await onRefresh()
          }}
        />
      )}
      {faceCheckInOpen && (
        <FaceVerificationCheckIn
          businessId={businessId}
          open
          onClose={() => setFaceCheckInOpen(false)}
          onSuccess={async () => {
            await onRefresh()
            await onCheckInSuccess?.()
            // Take staff straight to their Office Hub after a successful check-in.
            setFaceCheckInOpen(false)
            router.push('/portal/office')
          }}
        />
      )}
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
    location: await requireHighAccuracyLocation(),
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

function AdvanceRecoveryNotice({
  wallet,
  businessId,
  onAck,
}: {
  wallet: EmployeeWalletResponse | null
  businessId: string
  onAck: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const outstanding = Number(wallet?.summary?.outstandingAdvance ?? 0)

  // Show only while an advance is still owed AND not yet acknowledged today.
  if (outstanding <= 0) return null
  if (wallet?.advanceNoticeAckedToday) return null
  if (dismissed) return null

  async function acknowledge() {
    setBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/wallet/advance-notice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      })
      if (!result.ok) return
      setDismissed(true)
      onAck()
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div variants={fadeUp} className="mb-4">
      <div className="rounded-2xl border border-amber-500/45 bg-amber-500/12 p-4 shadow-[0_0_0_1px_rgba(245,158,11,0.08)]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-xl leading-none">📩</span>
          <div className="flex-1">
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-amber-300">অগ্রিম বেতন নোটিশ</p>
            <p className="mt-1.5 text-sm font-bold text-cream">
              আপনি অগ্রিম (advance) বেতন নিয়েছেন — বাকি ৳{Math.round(outstanding).toLocaleString('en-BD')}।
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-amber-100/90">
              এই টাকা আপনার পরের মাসের বেতন থেকে অটোমেটিক কেটে নেওয়া হবে। পুরোটা শোধ না হওয়া পর্যন্ত এই নোটিশ প্রতিদিন একবার দেখাবে।
            </p>
            <div className="mt-3">
              <Button size="sm" variant="gold" onClick={() => void acknowledge()} disabled={busy}>
                {busy ? 'অপেক্ষা করুন…' : 'বুঝেছি'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function WalletOverviewCard({ loading, wallet }: { loading: boolean; wallet: EmployeeWalletResponse | null }) {
  const s = wallet?.summary
  return (
    <Card className="p-5 border-gold-dim/25 bg-card/78">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold mb-4">Employee wallet</p>
      {loading ? <Skeleton className="h-40 w-full" /> : !s ? (
        <Empty icon="◇" title="Wallet not active" desc="Link your HR employee ID to view salary balance." />
      ) : (
        <>
        {Number(s.outstandingAdvance) > 0 && (
          <div className="mb-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-[9px] font-bold uppercase tracking-wider text-amber-300">বকেয়া অগ্রিম · পরের বেতন থেকে কাটা হবে</p>
            <p className="mt-1 font-mono text-lg font-black text-amber-300">{money(s.outstandingAdvance)}</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <WalletStat label="Current balance" value={money(s.currentBalance)} tone="text-green-400" />
          <WalletStat label="Withdrawable" value={money(s.availableWithdrawable)} tone="text-gold-lt" />
          <WalletStat label="Salary earned" value={money(s.totalAccrued)} />
          <WalletStat label="Commission" value={money(s.totalCommissions)} tone="text-green-400" />
          <WalletStat label="Eid bonus" value={money(s.totalEidBonuses)} />
          <WalletStat label="Overtime" value={money(s.totalOvertime)} />
          <WalletStat label="Penalties" value={money(s.totalPenalties)} tone="text-red-400" />
          <WalletStat label="Meal deductions" value={money(s.totalMealDeductions)} tone="text-red-400" />
          <WalletStat label="Advances" value={money(s.totalAdvances)} tone="text-amber-600" />
          <WalletStat label="Withdrawals" value={money(s.totalWithdrawals)} tone="text-muted-hi" />
        </div>
        </>
      )}
    </Card>
  )
}

function WalletStat({ label, value, tone = 'text-cream' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.04] p-3">
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold ${tone}`}>{value}</p>
    </div>
  )
}

function MealAllowanceCard({
  businessId,
  empLinked,
  loading,
  eligibility,
  onSubmitted,
}: {
  businessId: string
  empLinked: boolean
  loading: boolean
  eligibility: MealEligibility | null
  onSubmitted: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (loading) {
    return (
      <Card className="p-5 border-gold-dim/20">
        <Skeleton className="h-24 w-full" />
      </Card>
    )
  }

  if (!eligibility?.enabled) return null

  const amount = Number(eligibility.amountBdt || 0)
  const pending = eligibility.pendingRequest
  const canRequest = eligibility.canRequestToday

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const r = reason.trim()
    if (!r) {
      toast.error('Please add a short reason')
      return
    }
    setBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/meal-allowance/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, reason: r }),
      })
      if (!result.ok) return
      toast.success('Meal allowance request submitted')
      setReason('')
      onSubmitted()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-gold-dim/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Meal Allowance</p>
          {canRequest ? (
            <p className="mt-2 text-[11px] text-muted">No kitchen today? Request your meal allowance.</p>
          ) : pending?.status === 'APPROVED' ? (
            <p className="mt-2 text-[11px] text-muted">Meal allowance approved for today</p>
          ) : (
            <p className="mt-2 text-[11px] text-muted">Request pending approval</p>
          )}
        </div>
        <span className="rounded-full border border-gold-dim/40 bg-gold/10 px-3 py-1 text-[11px] font-bold text-gold-lt">
          {pending?.status === 'PENDING'
            ? `PENDING ${money(pending.amountBdt ?? amount)}`
            : pending?.status === 'APPROVED'
              ? `APPROVED ${money(pending.amountBdt ?? amount)}`
              : money(amount)}
        </span>
      </div>

      {canRequest ? (
        <form onSubmit={submit} className="space-y-3 text-[11px]">
          <label className="block space-y-1">
            <span className="text-muted">Reason</span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. No food arranged today"
              disabled={!empLinked || busy}
              className="w-full rounded-xl bg-card/85 border border-white/[0.08] px-3 py-2 text-cream text-sm resize-none disabled:opacity-40"
            />
          </label>
          <Button variant="gold" type="submit" className="w-full justify-center" disabled={busy || !empLinked}>
            {busy ? 'Submitting…' : `Request ${money(amount)} allowance`}
          </Button>
        </form>
      ) : eligibility.reason ? (
        <p className="text-[11px] text-muted">{eligibility.reason}</p>
      ) : null}
      {!empLinked && canRequest && (
        <p className="text-[11px] text-amber-600">Ask an admin to link your HR employee ID before requesting meal allowance.</p>
      )}
    </Card>
  )
}

function DrivingModeCard({
  businessId,
  empLinked,
  loading,
  status,
  onChanged,
}: {
  businessId: string
  empLinked: boolean
  loading: boolean
  status: DrivingStatus | null
  onChanged: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  if (loading) {
    return (
      <Card className="p-5 border-gold-dim/20">
        <Skeleton className="h-24 w-full" />
      </Card>
    )
  }

  if (!status?.enabled) return null

  const active = status.activeSession
  const pending = status.pendingSession

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/driving-mode/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, reason: reason.trim() }),
      })
      if (!result.ok) return
      toast.success('Driving mode request sent for approval')
      setReason('')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function end() {
    setBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/driving-mode/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      })
      if (!result.ok) return
      toast.success('Driving mode ended — welcome back')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-5 space-y-4 border-gold-dim/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">🚗 Driving Mode</p>
          {active ? (
            <p className="mt-2 text-[11px] text-muted">You are on the road — office follow-ups are paused.</p>
          ) : pending ? (
            <p className="mt-2 text-[11px] text-muted">Driving mode request pending approval.</p>
          ) : (
            <p className="mt-2 text-[11px] text-muted">Going on the road? Start driving mode so the office pauses your follow-ups.</p>
          )}
        </div>
        <span className="rounded-full border border-gold-dim/40 bg-gold/10 px-3 py-1 text-[11px] font-bold text-gold-lt">
          {active ? 'DRIVING' : pending ? 'PENDING' : 'OFF'}
        </span>
      </div>

      {active ? (
        <Button variant="secondary" className="w-full justify-center" disabled={busy} onClick={() => void end()}>
          {busy ? 'Ending…' : 'End driving — back to work'}
        </Button>
      ) : pending ? (
        <p className="text-[11px] text-muted">{status.reason || 'Waiting for the owner to approve.'}</p>
      ) : status.canStart ? (
        <form onSubmit={start} className="space-y-3 text-[11px]">
          <label className="block space-y-1">
            <span className="text-muted">Reason (optional)</span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Going for delivery / pickup"
              disabled={!empLinked || busy}
              className="w-full rounded-xl bg-card/85 border border-white/[0.08] px-3 py-2 text-cream text-sm resize-none disabled:opacity-40"
            />
          </label>
          <Button variant="gold" type="submit" className="w-full justify-center" disabled={busy || !empLinked}>
            {busy ? 'Submitting…' : 'Start driving mode'}
          </Button>
        </form>
      ) : status.reason ? (
        <p className="text-[11px] text-muted">{status.reason}</p>
      ) : null}
      {!empLinked && (
        <p className="text-[11px] text-amber-600">Ask an admin to link your HR employee ID first.</p>
      )}
    </Card>
  )
}

function WalletRequestCard({
  businessId,
  empLinked,
  availableWithdrawable,
  onSubmitted,
}: {
  businessId: string
  empLinked: boolean
  availableWithdrawable: number
  onSubmitted: () => void
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [type, setType] = useState<'WITHDRAWAL' | 'ADVANCE'>('WITHDRAWAL')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const amt = roundMoney(Number(amount))
    const r = reason.trim()
    if (!amt || amt <= 0 || !r) {
      toast.error('Amount and reason required')
      return
    }
    if (type === 'WITHDRAWAL' && amt > availableWithdrawable) {
      toast.error(
        `আপনার ওয়ালেটে আছে ৳${Math.round(availableWithdrawable).toLocaleString('en-BD')} — এর বেশি টাকা তোলা যাবে না। বেশি দরকার হলে আগে অগ্রিম (advance) রিকোয়েস্ট পাঠান।`,
      )
      return
    }
    setBusy(true)
    try {
      const result = await safeFetchJsonWithToast('/api/payroll/wallet/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: amt, reason: r, business_id: businessId }),
      })
      if (!result.ok) return
      toast.success(type === 'WITHDRAWAL' ? 'উত্তোলনের অনুরোধ গেছে — অনুমোদনের অপেক্ষায়' : 'অগ্রিমের অনুরোধ গেছে — অনুমোদনের অপেক্ষায়')
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
              className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${type === t ? 'border-gold-dim/50 bg-gold/15 text-gold-lt' : 'border-white/[0.08] bg-card/85 text-muted hover:text-cream'}`}
            >
              {t === 'WITHDRAWAL' ? 'টাকা তুলব (উত্তোলন)' : 'অগ্রিম চাইব (ধার)'}
            </button>
          ))}
        </div>
        <p className="rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-[10px] leading-relaxed text-muted">
          {type === 'WITHDRAWAL'
            ? 'উত্তোলন: আপনার ওয়ালেটে জমা টাকা হাতে/বিকাশে নেবেন। ওয়ালেটে যত আছে তার বেশি তোলা যাবে না।'
            : 'অগ্রিম: বেতনের আগে ধার — অনুমোদন হলে টাকা ওয়ালেটে জমা হবে, পরের বেতন থেকে অটো কাটা যাবে।'}
        </p>
        <label className="block space-y-1">
          <span className="text-muted">Amount (৳)</span>
          <Input value={amount} onChange={e => setAmount(e.target.value)} type="number" min={1} step="1" className="font-mono" disabled={!empLinked} />
          {type === 'WITHDRAWAL' && (
            <span className="block text-[10px] text-muted">তুলতে পারবেন সর্বোচ্চ ৳{Math.round(availableWithdrawable).toLocaleString('en-BD')}</span>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-muted">Reason</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} disabled={!empLinked} className="w-full rounded-xl bg-card/85 border border-white/[0.08] px-3 py-2 text-cream text-sm resize-none disabled:opacity-40" />
        </label>
        <Button variant="gold" type="submit" className="w-full justify-center" disabled={busy || !empLinked}>{busy ? 'Sending…' : 'Submit request'}</Button>
      </form>
      {!empLinked && <p className="text-[11px] text-amber-600">Ask an admin to link your HR employee ID before requesting wallet movements.</p>}
    </Card>
  )
}

function RequestList({ requests }: { requests: WalletRequestDto[] }) {
  if (!requests?.length) return <p className="text-[11px] text-muted">No wallet requests yet.</p>
  return (
    <ul className="space-y-1.5 max-h-44 overflow-y-auto text-[11px]">
      {requests.slice(0, 20).map(r => (
        <li key={r.id} className="flex justify-between gap-2 border-b border-white/[0.04] pb-1.5">
          <span className="text-muted font-mono">{r.createdAt.slice(0, 10)}</span>
          <span className="text-cream flex-1">{r.type === 'ADVANCE' ? 'অগ্রিম (ধার)' : 'উত্তোলন'} · {money(r.requestedAmount)}</span>
          <span className={r.status === 'PENDING' ? 'text-amber-400' : r.status.includes('APPROVED') ? 'text-green-400' : 'text-red-400'}>{r.status.replace(/_/g, ' ')}</span>
        </li>
      ))}
    </ul>
  )
}

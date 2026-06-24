import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner, normalizeAlmaRole, filterNavByRole } from '@/lib/roles'
import { getNavForBusiness, BUSINESSES, type BusinessId } from '@/lib/businesses'
import { prisma } from '@/lib/prisma'
import { getOwnerHubData, getStaffOfficeData } from '@/agent/lib/office-hub'
import OfficeShell from './office-shell'
import { OFFICE_CSS } from './office-css'

export const metadata = { title: 'আমার অফিস · ALMA' }
export const dynamic = 'force-dynamic'

/** Bangla long date for the header, e.g. "২৪ জুন, মঙ্গলবার". */
function dhakaHeaderDate(): string {
  const dm = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'long' }).format(new Date())
  const wd = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', weekday: 'long' }).format(new Date())
  return `${dm}, ${wd}`
}

export default async function StaffOfficePage() {
  // Kill switch — office surface follows the agent module.
  if (!isAgentEnabled()) redirect('/portal')

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')

  const owner = isSystemOwner(session)

  // Resolve the staff record linked to THIS user only. The data query is keyed
  // off the authenticated user id — a staff member can never see another's tasks.
  const staff = await prisma.agentStaff.findFirst({
    where: { userId: session.user.id, active: true },
    select: { id: true, name: true, businessId: true },
  })

  const headerDate = dhakaHeaderDate()
  const businessId = staff?.businessId ?? 'ALMA_LIFESTYLE'

  // Staff office data (interactive app) — tasks, proofs, threads, self-initiated.
  const staffData = staff ? await getStaffOfficeData(staff) : null

  // Owner Hub — pending-approval queue, update-tracking, team status, leaderboard.
  const hub = owner ? await getOwnerHubData(businessId) : null

  // ERP nav links for the slide-in drawer — same role-filtered set the ERP
  // sidebar shows, so the owner can reach the rest of the ERP from inside the
  // office overlay (which paints over the normal sidebar). We drop the office's
  // own entry since the user is already here.
  const navBusinessId: BusinessId = (businessId in BUSINESSES ? businessId : 'ALMA_LIFESTYLE') as BusinessId
  const role = normalizeAlmaRole(session.user.role)
  const navItems = filterNavByRole(getNavForBusiness(navBusinessId), role, navBusinessId)
    .filter((n) => n.href !== '/portal/office')
    .map((n) => ({ href: n.href, icon: n.icon, label: n.label }))

  return (
    <div className="ohub">
      <style dangerouslySetInnerHTML={{ __html: OFFICE_CSS }} />
      <OfficeShell
        owner={hub}
        staff={staffData}
        self={owner ? 'owner' : 'staff'}
        headerDate={headerDate}
        navItems={navItems}
      />
    </div>
  )
}

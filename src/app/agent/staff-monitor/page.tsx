import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentStaffMonitor from '@/agent/components/AgentStaffMonitor'
import AgentControlCenter from '@/agent/components/monitor/AgentControlCenter'
import { StaffMonitorScrollWrapper } from './StaffMonitorScrollWrapper'

/** Live monitor: agentDuties + salahDuties from /api/agent/staff-monitor */

export const metadata = { title: 'ALMA Agent — LIVE Business' }

export default async function StaffMonitorPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <StaffMonitorScrollWrapper>
      <AgentControlCenter />
      <AgentStaffMonitor />
    </StaffMonitorScrollWrapper>
  )
}

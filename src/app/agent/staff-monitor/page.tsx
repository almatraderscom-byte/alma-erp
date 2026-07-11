import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentStaffMonitor from '@/agent/components/AgentStaffMonitor'
import AgentControlCenter from '@/agent/components/monitor/AgentControlCenter'
import ModelTogglePanel from '@/agent/components/monitor/ModelTogglePanel'
import HeartbeatPanel from '@/agent/components/monitor/HeartbeatPanel'
import LiveBrowserWatchPanel from '@/agent/components/monitor/LiveBrowserWatchPanel'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
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
      <AgentSubHeader title="LIVE" accent="Business" subtitle="কন্ট্রোল • হার্টবিট • স্টাফ মনিটর" />
      <AgentControlCenter />
      <ModelTogglePanel />
      <HeartbeatPanel />
      <LiveBrowserWatchPanel />
      <AgentStaffMonitor />
    </StaffMonitorScrollWrapper>
  )
}

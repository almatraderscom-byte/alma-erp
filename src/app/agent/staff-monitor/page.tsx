import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentStaffMonitor from '@/agent/components/AgentStaffMonitor'

/** Live monitor: agentDuties + salahDuties from /api/agent/staff-monitor */

export const metadata = { title: 'ALMA Agent — Staff Monitor' }

export default async function StaffMonitorPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-black">
      <AgentStaffMonitor />
    </div>
  )
}

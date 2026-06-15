import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentCostsDashboard from '@/agent/components/AgentCostsDashboard'
import AgentShell from '@/agent/components/AgentShell'

export const metadata = { title: 'ALMA Agent — Costs' }

export default async function AgentCostsPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <AgentShell>
      <div className="h-full min-h-0 overflow-y-auto">
        <AgentCostsDashboard />
      </div>
    </AgentShell>
  )
}

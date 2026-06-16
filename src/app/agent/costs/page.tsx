import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentCostsDashboard from '@/agent/components/AgentCostsDashboard'
import { CostsScrollWrapper } from './CostsScrollWrapper'

export const metadata = { title: 'ALMA Agent — Costs' }

export default async function AgentCostsPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <CostsScrollWrapper>
      <AgentCostsDashboard />
    </CostsScrollWrapper>
  )
}

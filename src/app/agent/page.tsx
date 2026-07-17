import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentApp from '@/agent/components/AgentApp'

export const metadata = { title: 'ALMA Agent' }

export default async function AgentPage({
  searchParams,
}: {
  searchParams?: { monitor?: string }
}) {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  // Phase 37: /agent?monitor=graph → the rollout/kill-switch health panel
  // (owner-gated by the checks above; read-only server render).
  if (searchParams?.monitor === 'graph') {
    const { default: GraphHealthPanel } = await import('@/agent/components/monitor/GraphHealthPanel')
    return <GraphHealthPanel />
  }

  return <AgentApp userName={session.user.name ?? session.user.email ?? 'Owner'} />
}

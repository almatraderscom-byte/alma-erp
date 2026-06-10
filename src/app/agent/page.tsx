import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentApp from '@/agent/components/AgentApp'

export const metadata = { title: 'ALMA Agent' }

export default async function AgentPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <AgentApp userName={session.user.name ?? session.user.email ?? 'Owner'} />
  )
}

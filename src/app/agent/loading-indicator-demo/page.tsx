import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import AgentActivityDemo from '@/agent/components/demo/AgentActivityDemo'

export const metadata = { title: 'ALMA Agent — Activity Demo' }

export default async function AgentLoadingIndicatorDemoPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <AgentActivityDemo />
}

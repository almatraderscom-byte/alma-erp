import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import HomeDemoView from './HomeDemoView'

export const metadata = { title: 'ALMA Agent — Home (Demo)' }

/**
 * Isolated, owner-only preview of a redesigned agent home screen ("Modern AI glassy").
 * Purely presentational with sample data — it does NOT touch the real agent home
 * (AgentEmptyState/AgentApp). Used to get the owner's sign-off before implementing.
 */
export default async function AgentHomeDemoPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <HomeDemoView userName={session.user.name ?? session.user.email ?? 'Sir'} />
}

import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import GrowthConnections from '@/agent/components/growth/GrowthConnections'

export const metadata = {
  title: 'Growth — Connections',
  robots: 'noindex',
}

export default async function GrowthPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <GrowthConnections />
}

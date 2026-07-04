import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import LiveBrowserWatchPanel from '@/agent/components/monitor/LiveBrowserWatchPanel'

/**
 * P1 live watch page — the owner supervises the live-browser companion from any
 * device (responsive; the same page works from the phone): step feed, newest
 * screenshot, server-side STOP.
 */

export const metadata = { title: 'ALMA Agent — Live Watch' }

export default async function LiveWatchPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full overflow-y-auto pb-24">
      <AgentSubHeader title="Live" accent="Watch" subtitle="এজেন্ট ব্রাউজারে কী করছে — লাইভ" />
      <LiveBrowserWatchPanel />
    </div>
  )
}

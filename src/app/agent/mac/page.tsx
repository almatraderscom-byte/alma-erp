import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import MacControlPanel from '@/agent/components/monitor/MacControlPanel'

/**
 * The owner's control surface for Mac control (M1–M4).
 *
 * Distinct from the two browser pages: /agent/browser-live is the browser ON THE
 * SERVER, /agent/live-watch supervises the companion in his Chrome. This one is
 * his actual laptop — the machine with his files on it — which is why the
 * capability ships OFF and this page leads with the switch that turns it on.
 */

export const metadata = { title: 'ALMA Agent — Mac Control' }

export default async function MacControlPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full overflow-y-auto pb-24">
      <AgentSubHeader
        title="Mac"
        accent="Control"
        subtitle="আপনার নিজের Mac — এজেন্ট কী করতে পারবে, আর কী কী করেছে"
      />
      <MacControlPanel />
    </div>
  )
}

import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import VpsLiveBrowserPanel from '@/agent/components/monitor/VpsLiveBrowserPanel'

/**
 * The VPS live browser — distinct from /agent/live-watch, which supervises the
 * companion running in the owner's OWN Chrome. This one is the browser on the
 * server: it needs no Mac awake, and the owner reaches into it only when a page
 * asks for something the agent cannot do alone (a login, a captcha).
 */

export const metadata = { title: 'ALMA Agent — Live Browser' }

export default async function BrowserLivePage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full overflow-y-auto pb-24">
      <AgentSubHeader
        title="Live"
        accent="Browser"
        subtitle="VPS-এর ব্রাউজার — দেখুন, দরকারে নিজে হাত দিন"
      />
      <VpsLiveBrowserPanel />
    </div>
  )
}

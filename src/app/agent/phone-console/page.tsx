import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import PhoneConsole from '@/agent/components/phone/PhoneConsole'

/**
 * The PBX console. `/agent/phone` is the staff softphone — used DURING a call, by anyone.
 * This is the owner's view OF the phone system: the line, who is on it, what happened, and
 * how the audio held up. Owner-only by role, and read-only in this step.
 */

export const metadata = { title: 'ALMA Agent — ফোন কনসোল' }

export default async function PhoneConsolePage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full overflow-y-auto">
      <AgentSubHeader
        title="ফোন"
        accent="কনসোল"
        subtitle="লাইন • লাইভ কল • আজকের হিসাব • কল লগ ও রেকর্ডিং"
      />
      <PhoneConsole />
    </div>
  )
}

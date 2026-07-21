import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import KnownPeopleManager from '@/agent/components/known-people/KnownPeopleManager'
import CameraListenCard from '@/agent/components/known-people/CameraListenCard'

/** Camera face registry + entrance-watch settings (owner-only). */

export const metadata = { title: 'ALMA Agent — চেনা মুখ' }

export default async function KnownPeoplePage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full overflow-y-auto">
      <AgentSubHeader
        title="চেনা"
        accent="মুখ"
        subtitle="এন্ট্রান্স ক্যামেরা • কে ঢুকলো-বের হলো • অপরিচিত অ্যালার্ট"
      />
      <div className="mx-auto max-w-3xl px-4 pt-4">
        <CameraListenCard />
      </div>
      <KnownPeopleManager />
    </div>
  )
}

import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isOpenAIRealtimeTrialEnabled } from '@/agent/lib/openai-realtime-trial'
import { isSystemOwner } from '@/lib/roles'
import OpenAIRealtimeTrial from '@/agent/components/voice/OpenAIRealtimeTrial'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'ALMA — GPT Realtime 2.1 Trial' }

export default async function VoiceTrialPage() {
  if (!isAgentEnabled() || !isOpenAIRealtimeTrialEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <OpenAIRealtimeTrial />
}

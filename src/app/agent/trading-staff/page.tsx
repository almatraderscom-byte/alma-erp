import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { AgentSubHeader } from '@/agent/components/AgentSubHeader'
import TradingStaffAdmin from './TradingStaffAdmin'

export const metadata = { title: 'ALMA Agent — Trading Staff' }

export default async function TradingStaffPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-transparent pb-[calc(4.5rem+env(safe-area-inset-bottom))] text-cream">
      <AgentSubHeader title="ALMA Trading" accent="Staff" subtitle="Binance P2P trader-দের লিঙ্ক ও Telegram chat ID" />
      <TradingStaffAdmin />
    </div>
  )
}

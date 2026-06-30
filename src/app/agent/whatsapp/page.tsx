import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import WhatsAppInbox from '@/agent/components/WhatsAppInbox'

/** Owner-only WhatsApp-style inbox: live view of inbound WhatsApp messages. */
export const metadata = { title: 'ALMA Agent — WhatsApp' }

export default async function WhatsAppPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <WhatsAppInbox />
}

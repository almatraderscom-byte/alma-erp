import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import CreativeStudio from '@/agent/components/creative-studio/CreativeStudio'

export const metadata = {
  title: 'Creative Studio',
  robots: 'noindex',
}

export default async function CreativeStudioPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <CreativeStudio />
}

import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { CreativeStudioEnterpriseDemo } from '@/agent/components/creative-studio-demo/CreativeStudioEnterpriseDemo'

export const metadata = {
  title: 'Enterprise Studio Concept · ALMA',
  robots: 'noindex',
}

export default async function CreativeStudioEnterpriseDemoPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <CreativeStudioEnterpriseDemo />
}

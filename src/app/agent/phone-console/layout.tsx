import type { ReactNode } from 'react'
import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { ConsoleShell } from '@/agent/components/phone/console/ConsoleShell'

/**
 * The PBX console section. `/agent/phone` is the staff softphone — the phone itself, used
 * during a call by whoever answers. This is the owner's console FOR the phone system: the
 * line, who is on it, what happened, what it sounded like.
 *
 * Owner-only, and enforced here rather than per page so a new sub-page cannot ship open by
 * omission — which matters more from step 2 on, since the settings pages under here CHANGE
 * how a live business line behaves. Every API route they call re-checks the same rule; a
 * route that trusted this layout would be open to anyone with a URL.
 */

export const metadata = { title: 'ALMA — ফোন কনসোল' }

export default async function PhoneConsoleLayout({ children }: { children: ReactNode }) {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')
  if (!isSystemOwner(session)) notFound()

  return <ConsoleShell>{children}</ConsoleShell>
}

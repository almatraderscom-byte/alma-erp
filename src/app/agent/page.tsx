import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const metadata = { title: 'Agent' }

export default async function AgentPage() {
  // (a) Kill switch
  if (!isAgentEnabled()) notFound()

  // (b) Require valid ALMA session
  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')

  // (c) Owner-only gate — SUPER_ADMIN only
  if (!isSystemOwner(session)) notFound()

  // DB ping — cheap SELECT to verify agent tables are reachable
  let dbOk = false
  try {
    await (prisma as any).agentProject.findFirst({ select: { id: true } })
    dbOk = true
  } catch {
    dbOk = false
  }

  return (
    <div style={{ padding: '2rem', fontFamily: 'var(--font-inter, sans-serif)' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>
        Agent — Phase 0
      </h1>

      <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <li>✅ Feature flag ON</li>
        <li>✅ Auth OK — {session.user.name ?? session.user.email}</li>
        <li>{dbOk ? '✅' : '❌'} Database {dbOk ? 'OK' : 'ERROR — agent tables not reachable'}</li>
      </ul>
    </div>
  )
}

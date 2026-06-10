import { notFound, redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isAgentEnabled } from '@/agent/config'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import AgentChat from '@/agent/components/AgentChat'

export const metadata = { title: 'Agent' }

export default async function AgentPage() {
  if (!isAgentEnabled()) notFound()

  const session = await getServerSession(authOptions)
  if (!session?.user) redirect('/login')

  if (!isSystemOwner(session)) notFound()

  let dbOk = false
  try {
    await (prisma as any).agentProject.findFirst({ select: { id: true } })
    dbOk = true
  } catch {
    dbOk = false
  }

  return (
    <div style={{ padding: '1.5rem', fontFamily: 'var(--font-inter, sans-serif)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>ALMA Agent</h1>
        <span style={{ fontSize: '0.75rem', color: dbOk ? '#16a34a' : '#dc2626' }}>
          {dbOk ? '● DB OK' : '● DB ERROR'}
        </span>
      </div>
      {!dbOk && (
        <div style={{ marginBottom: '1rem', padding: '0.75rem', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '6px', fontSize: '0.85rem', color: '#b91c1c' }}>
          Agent tables not reachable — run <code>prisma migrate deploy</code> first.
        </div>
      )}
      <AgentChat userName={session.user.name ?? session.user.email ?? 'Owner'} />
    </div>
  )
}

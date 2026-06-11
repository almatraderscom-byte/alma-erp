// VPS worker polls this endpoint to find approved jobs.
// Authenticated with AGENT_INTERNAL_TOKEN (constant-time compare).
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const jobs = await db.agentPendingAction.findMany({
    where: {
      status: 'approved',
      type: { in: ['image_gen', 'long_agent_task'] },
    },
    orderBy: { createdAt: 'asc' },
    take: 10,
  })

  return Response.json({ jobs })
}

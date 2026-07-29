/**
 * Agent-call history — WhatsApp-style call log for the app (owner request
 * 2026-07-29). Recent agent → owner in-app calls, newest first.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const calls = await prisma.agentAppCall.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      purpose: true,
      source: true,
      status: true,
      createdAt: true,
      answeredAt: true,
      endedAt: true,
    },
  })
  return Response.json({ calls })
}

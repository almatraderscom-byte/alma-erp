import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  const body = await req.json().catch(() => ({}))

  const data: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
  if (typeof body.description === 'string') data.description = body.description.trim() || null
  if (typeof body.systemInstructions === 'string') data.systemInstructions = body.systemInstructions.trim() || null
  if (body.businessId === 'ALMA_TRADING' || body.businessId === 'ALMA_LIFESTYLE' || body.businessId === null) {
    data.businessId = body.businessId
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await (prisma as any).agentProject.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true, systemInstructions: true, businessId: true, updatedAt: true },
  })

  return Response.json(updated)
}

import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const projects = await (prisma as any).agentProject.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true, name: true, description: true, systemInstructions: true,
      businessId: true, createdAt: true, updatedAt: true,
    },
  })

  return Response.json(projects)
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return Response.json({ error: 'name_required' }, { status: 400 })

  const businessId =
    body.businessId === 'ALMA_TRADING' || body.businessId === 'ALMA_LIFESTYLE'
      ? body.businessId
      : null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const project = await (prisma as any).agentProject.create({
    data: {
      name,
      description: typeof body.description === 'string' ? body.description.trim() || null : null,
      systemInstructions: typeof body.systemInstructions === 'string' ? body.systemInstructions.trim() || null : null,
      businessId,
    },
    select: {
      id: true, name: true, description: true, systemInstructions: true,
      businessId: true, createdAt: true, updatedAt: true,
    },
  })

  return Response.json(project, { status: 201 })
}

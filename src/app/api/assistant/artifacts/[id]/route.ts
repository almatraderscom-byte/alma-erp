/**
 * Artifact delete (2026-07-16 panel-final): the file list is now a real file
 * manager, so the owner can remove files he no longer needs. Version
 * snapshots cascade with the artifact (FK onDelete: Cascade).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const existing = await db.agentArtifact.findUnique({ where: { id: params.id }, select: { id: true } })
  if (!existing) return Response.json({ error: 'not_found' }, { status: 404 })

  await db.agentArtifact.delete({ where: { id: params.id } })
  return Response.json({ deleted: true })
}

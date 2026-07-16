/**
 * Artifact version history (Claude-app parity, 2026-07-16).
 *
 * GET  → { current: {...}, versions: [{version, title, type, createdAt, content?}] }
 *        ?v=N includes that snapshot's content (list stays content-free to keep
 *        the payload small — bodies can be whole reports).
 * POST → { restore: N } snapshots the current body, then makes version N's
 *        content the new current (as a NEW version — history is append-only,
 *        same model as the Claude app's restore).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function requireOwner(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const artifact = await db.agentArtifact.findUnique({
    where: { id: params.id },
    select: { id: true, title: true, type: true, version: true, createdAt: true },
  })
  if (!artifact) return Response.json({ error: 'not_found' }, { status: 404 })

  const wantV = Number(req.nextUrl.searchParams.get('v') ?? NaN)
  const versions = await db.agentArtifactVersion.findMany({
    where: { artifactId: params.id },
    orderBy: { version: 'desc' },
    select: { version: true, title: true, type: true, createdAt: true },
  })

  let requested: { version: number; content: string | null; title: string | null; type: string | null } | null = null
  if (Number.isInteger(wantV)) {
    requested = await db.agentArtifactVersion.findUnique({
      where: { artifactId_version: { artifactId: params.id, version: wantV } },
      select: { version: true, content: true, title: true, type: true },
    })
    if (!requested) return Response.json({ error: 'version_not_found' }, { status: 404 })
  }

  return Response.json({ current: artifact, versions, requested })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOwner(req)
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const restore = Number(body?.restore ?? NaN)
  if (!Number.isInteger(restore)) return Response.json({ error: 'restore_version_required' }, { status: 400 })

  const artifact = await db.agentArtifact.findUnique({
    where: { id: params.id },
    select: { id: true, title: true, type: true, content: true, version: true },
  })
  if (!artifact) return Response.json({ error: 'not_found' }, { status: 404 })

  const snapshot = await db.agentArtifactVersion.findUnique({
    where: { artifactId_version: { artifactId: params.id, version: restore } },
    select: { content: true, type: true, title: true },
  })
  if (!snapshot) return Response.json({ error: 'version_not_found' }, { status: 404 })

  const [, updated] = await db.$transaction([
    db.agentArtifactVersion.upsert({
      where: { artifactId_version: { artifactId: artifact.id, version: artifact.version ?? 1 } },
      create: {
        artifactId: artifact.id,
        version: artifact.version ?? 1,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
      },
      update: {},
    }),
    db.agentArtifact.update({
      where: { id: artifact.id },
      data: { content: snapshot.content, type: snapshot.type ?? artifact.type, version: (artifact.version ?? 1) + 1 },
      select: { id: true, conversationId: true, messageId: true, type: true, title: true, content: true, version: true, createdAt: true },
    }),
  ])

  return Response.json(updated)
}

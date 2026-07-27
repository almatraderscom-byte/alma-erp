import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isSelectableModelId } from '@/agent/lib/models/registry'
import { isChatMode } from '@/agent/lib/chat-mode'
import { isPermissionMode } from '@/agent/lib/permission-mode'
import { prisma } from '@/lib/prisma'

/**
 * One conversation's settings. The web app reads this when a deep link handed it
 * only an id — without it a 'plan' chat would silently reopen as 'auto', with
 * every withheld tool re-armed.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)
  const conv = await prisma.agentConversation.findUnique({
    where: { id },
    select: {
      id: true, title: true, projectId: true, archived: true, pinned: true,
      modelId: true, chatMode: true, permissionMode: true, updatedAt: true,
    },
  })
  if (!conv) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(conv)
}

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
  if (typeof body.title === 'string') data.title = body.title.trim() || null
  if (typeof body.archived === 'boolean') data.archived = body.archived
  if (typeof body.pinned === 'boolean') data.pinned = body.pinned
  if (body.projectId !== undefined) data.projectId = body.projectId || null

  if (typeof body.modelId === 'string') {
    const id = body.modelId.trim()
    // Accept any real model id OR the 'auto' sentinel (owner lets the router pick).
    if (!isSelectableModelId(id)) {
      return Response.json({ error: 'invalid_model' }, { status: 400 })
    }
    data.modelId = id
  }

  // Owner's chat mode picker: auto | direct | plan | plan_drive. Rejected rather
  // than defaulted on a bad value — a silently ignored mode change would be worse
  // than an error, because the owner would believe the agent is restrained.
  if (body.chatMode !== undefined) {
    if (!isChatMode(body.chatMode)) {
      return Response.json({ error: 'invalid_chat_mode' }, { status: 400 })
    }
    data.chatMode = body.chatMode
  }

  // PM-1 — the permission axis: plan | careful | standard | supervised |
  // elevated. Same reasoning as above, and more so: a silently ignored
  // permission change would leave Boss believing the agent is restrained when it
  // is not. Rejected loudly, never defaulted.
  if (body.permissionMode !== undefined) {
    if (!isPermissionMode(body.permissionMode)) {
      return Response.json({ error: 'invalid_permission_mode' }, { status: 400 })
    }
    data.permissionMode = body.permissionMode
    // Leaving 'elevated' drops the grant with it — a time-boxed permission must
    // never survive the mode that justified it.
    if (body.permissionMode !== 'elevated') data.elevationGrant = null
  }

  const updated = await prisma.agentConversation.update({
    where: { id },
    data,
    select: {
      id: true, title: true, projectId: true, archived: true, pinned: true,
      modelId: true, chatMode: true, permissionMode: true, updatedAt: true,
    },
  })

  return Response.json(updated)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await Promise.resolve(params)

  // Messages + artifacts cascade via FK ON DELETE CASCADE.
  await prisma.agentConversation.delete({ where: { id } })

  return new Response(null, { status: 204 })
}

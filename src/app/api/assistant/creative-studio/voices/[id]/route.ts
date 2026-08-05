import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { canActivateVoiceVersion, OWNER_STUDIO_USAGE_CONTEXT } from '@/lib/creative-studio/voice-policy'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function ownerId(req: NextRequest): Promise<string | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return token.sub
}

async function ownedVersion(owner: string, id: string) {
  return db.creativeVoiceVersion.findFirst({
    where: { id, voice: { ownerId: owner, ownerOnly: true } },
    include: { voice: true },
  })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  let body: { action?: 'activate' | 'revoke'; reason?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const version = await ownedVersion(owner, params.id)
  if (!version) return Response.json({ error: 'voice_version_not_found' }, { status: 404 })
  const reason = String(body.reason ?? '').trim().slice(0, 500) || null

  if (body.action === 'activate') {
    if (!canActivateVoiceVersion(version.status, version.providerVoiceId)) {
      return Response.json({ error: 'voice_version_not_ready' }, { status: 409 })
    }
    await db.$transaction(async (tx: typeof db) => {
      if (version.voice.activeVersionId && version.voice.activeVersionId !== version.id) {
        await tx.creativeVoiceVersion.updateMany({
          where: { id: version.voice.activeVersionId, status: 'active' },
          data: { status: 'ready' },
        })
      }
      await tx.creativeVoiceVersion.update({
        where: { id: version.id },
        data: { status: 'active', activatedAt: new Date(), revokedAt: null },
      })
      await tx.creativeVoice.update({
        where: { id: version.voiceId },
        data: { activeVersionId: version.id },
      })
      await tx.creativeVoiceAudit.create({
        data: {
          voiceId: version.voiceId,
          voiceVersionId: version.id,
          ownerId: owner,
          action: 'activated',
          reason,
          metadata: { version: version.version },
        },
      })
    })
    return Response.json({ ok: true, voiceVersionId: version.id, status: 'active' })
  }

  if (body.action === 'revoke') {
    if (version.status === 'deleted') return Response.json({ error: 'voice_version_deleted' }, { status: 409 })
    await db.$transaction(async (tx: typeof db) => {
      if (version.voice.activeVersionId === version.id) {
        await tx.creativeVoice.update({
          where: { id: version.voiceId },
          data: { activeVersionId: null },
        })
      }
      await tx.creativeVoiceVersion.update({
        where: { id: version.id },
        data: { status: 'revoked', revokedAt: new Date() },
      })
      await tx.creativeVoiceAudit.create({
        data: {
          voiceId: version.voiceId,
          voiceVersionId: version.id,
          ownerId: owner,
          action: 'revoked',
          reason,
          metadata: { providerDeletionRequired: Boolean(version.providerVoiceId) },
        },
      })
    })
    return Response.json({ ok: true, voiceVersionId: version.id, status: 'revoked' })
  }

  return Response.json({ error: 'invalid_action' }, { status: 422 })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  const version = await ownedVersion(owner, params.id)
  if (!version) return Response.json({ error: 'voice_version_not_found' }, { status: 404 })
  if (version.status === 'deleted') {
    return Response.json({ ok: true, voiceVersionId: version.id, status: 'deleted', idempotent: true })
  }

  let reason = 'Owner requested provider deletion'
  try {
    const body = await req.json()
    reason = String(body?.reason ?? reason).trim().slice(0, 500) || reason
  } catch {
    // DELETE body is optional.
  }

  const result = await db.$transaction(async (tx: typeof db) => {
    if (version.voice.activeVersionId === version.id) {
      await tx.creativeVoice.update({
        where: { id: version.voiceId },
        data: { activeVersionId: null },
      })
    }
    if (!version.providerVoiceId) {
      await tx.creativeVoiceVersion.update({
        where: { id: version.id },
        data: { status: 'deleted', revokedAt: version.revokedAt ?? new Date(), providerDeletedAt: new Date() },
      })
      await tx.creativeVoiceAudit.create({
        data: {
          voiceId: version.voiceId,
          voiceVersionId: version.id,
          ownerId: owner,
          action: 'deleted_before_provider_creation',
          reason,
        },
      })
      return { pendingActionId: null, status: 'deleted' }
    }
    await tx.creativeVoiceVersion.update({
      where: { id: version.id },
      data: { status: 'deletion_pending', revokedAt: version.revokedAt ?? new Date() },
    })
    const pending = await tx.agentPendingAction.create({
      data: {
        conversationId: null,
        type: 'audio_gen',
        payload: {
          audioLab: true,
          creativeStudio: true,
          skipTelegramCard: true,
          studioMode: 'voice_lifecycle',
          provider: 'elevenlabs',
          kind: 'voice_delete',
          ownerVoice: true,
          ownerId: owner,
          usageContext: OWNER_STUDIO_USAGE_CONTEXT,
          voiceId: version.voiceId,
          voiceVersionId: version.id,
        },
        summary: `🗑️ Provider voice deletion — v${version.version}`,
        costEstimate: 0,
        status: 'approved',
      },
    })
    await tx.creativeVoiceAudit.create({
      data: {
        voiceId: version.voiceId,
        voiceVersionId: version.id,
        ownerId: owner,
        action: 'provider_deletion_queued',
        reason,
        metadata: { pendingActionId: pending.id },
      },
    })
    return { pendingActionId: pending.id, status: 'deletion_pending' }
  })

  return Response.json({
    ok: true,
    voiceVersionId: version.id,
    pendingActionId: result.pendingActionId,
    status: result.status,
  }, { status: result.pendingActionId ? 202 : 200 })
}

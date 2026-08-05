import { createHash } from 'node:crypto'
import { type NextRequest } from 'next/server'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { audioCostBdt, audioProviderLabel } from '@/lib/creative-studio/audio-lab'
import { checkStudioCostConfirmation, normalizeStudioRunCap } from '@/lib/creative-studio/studio-policy'
import { isWithinPaidPreviewCeiling, OWNER_STUDIO_USAGE_CONTEXT } from '@/lib/creative-studio/voice-policy'
import {
  authenticateStudioRequest,
  studioAccessErrorResponse,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  filterStudioResourcesToScope,
  requireStudioResourceContext,
  studioResourceScopeKey,
} from '@/lib/creative-studio/studio-resource-scope'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any
const DEFAULT_CONSENT =
  'আমি নিশ্চিত করছি যে এটি আমার নিজের কণ্ঠ, আমি এই নমুনা দিয়ে ব্যক্তিগত Creative Studio voice clone তৈরির অনুমতি দিচ্ছি, এবং এটি কেবল আমার owner-only Studio কাজে ব্যবহার হবে।'

async function ownerActor(req: NextRequest): Promise<StudioActor | Response> {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  return actor
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  const projectId = req.nextUrl.searchParams.get('projectId')
  let ownerId: string
  let scope: Awaited<ReturnType<typeof requireStudioResourceContext>> | null = null
  if (brandProfileId || projectId) {
    try {
      scope = await requireStudioResourceContext(actor, {
        brandProfileId,
        projectId,
      })
      ownerId = scope.access.ownerId
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-voices-list')
    }
  } else {
    if (!isSystemOwner(actor.erpRole)) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
    ownerId = actor.userId
  }
  const ownerVoices = await db.creativeVoice.findMany({
    where: { ownerId },
    orderBy: { updatedAt: 'desc' },
    include: {
      versions: { orderBy: { version: 'desc' } },
      audits: { orderBy: { createdAt: 'desc' }, take: 50 },
    },
  })
  const voices = scope
    ? await filterStudioResourcesToScope('voice', ownerVoices, {
        ownerId,
        brandProfileId: scope.brandProfileId,
        projectId: scope.projectId,
      })
    : ownerVoices
  return Response.json({
    voices: voices.map((voice: Record<string, unknown>) => ({
      ...voice,
      versions: ((voice.versions ?? []) as Array<Record<string, unknown>>).map((version) => ({
        ...version,
        providerVoiceId: undefined,
        providerReady: Boolean(version.providerVoiceId),
      })),
    })),
    provider: 'ElevenLabs',
    usageContext: OWNER_STUDIO_USAGE_CONTEXT,
  })
}

export async function POST(req: NextRequest) {
  const actor = await ownerActor(req)
  if (actor instanceof Response) return actor
  const owner = actor.userId

  let body: {
    name?: string
    samplePaths?: string[]
    consent?: { accepted?: boolean; statement?: string }
    intent?: 'estimate' | 'queue'
    confirmedCostBdt?: number
    costCapBdt?: number
    brandProfileId?: string
    projectId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  let resourceContext: Awaited<ReturnType<typeof requireStudioResourceContext>> | null = null
  if (body.brandProfileId || body.projectId) {
    try {
      resourceContext = await requireStudioResourceContext(actor, body)
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-voice-create')
    }
  }

  const paths = (body.samplePaths ?? [])
    .filter((path): path is string =>
      typeof path === 'string'
      && path.startsWith('studio-video/audio/')
      && !path.includes('..'))
    .slice(0, 5)
  if (paths.length === 0) return Response.json({ error: 'voice_samples_required' }, { status: 422 })
  if (body.consent?.accepted !== true) {
    return Response.json({ error: 'voice_consent_required', consentStatement: DEFAULT_CONSENT }, { status: 422 })
  }
  const statement = String(body.consent.statement ?? DEFAULT_CONSENT).trim().slice(0, 2_000)
  if (statement.length < 30) return Response.json({ error: 'voice_consent_statement_invalid' }, { status: 422 })

  const costBdt = audioCostBdt('voice_clone')
  const defaultCapBdt = normalizeStudioRunCap(process.env.CREATIVE_STUDIO_MAX_RUN_COST_BDT)
  const provider = audioProviderLabel('voice_clone')
  if (!isWithinPaidPreviewCeiling(costBdt)) {
    return Response.json({ error: 'paid_preview_ceiling_exceeded', costBdt }, { status: 409 })
  }
  const gate = checkStudioCostConfirmation({
    estimateBdt: costBdt,
    confirmedCostBdt: body.intent === 'queue' ? body.confirmedCostBdt : undefined,
    capBdt: body.costCapBdt ?? defaultCapBdt,
  })
  const summary = `🧬 Owner voice clone — ${provider}`
  if (body.intent !== 'queue' || (!gate.ok && gate.reason === 'confirmation_required')) {
    return Response.json({
      ok: true,
      requiresConfirmation: true,
      provider,
      summary,
      costBdt,
      maxCostBdt: gate.capBdt,
      ceilingUsd: 1,
    })
  }
  if (!gate.ok) {
    return Response.json({
      error: gate.reason === 'cap_exceeded' ? 'cost_cap_exceeded' : 'cost_estimate_changed',
      costBdt: gate.estimateBdt,
      maxCostBdt: gate.capBdt,
    }, { status: 409 })
  }

  const name = String(body.name ?? 'Maruf — Owner Voice').trim().slice(0, 80) || 'Maruf — Owner Voice'
  const consentSha256 = createHash('sha256').update(statement, 'utf8').digest('hex')
  const consentRecordedAt = new Date()
  const created = await db.$transaction(async (tx: typeof db) => {
    const voice = await tx.creativeVoice.upsert({
      where: { ownerId_name: { ownerId: owner, name } },
      create: { ownerId: owner, name, provider: 'elevenlabs', ownerOnly: true },
      update: {},
    })
    const latest = await tx.creativeVoiceVersion.findFirst({
      where: { voiceId: voice.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    const version = await tx.creativeVoiceVersion.create({
      data: {
        voiceId: voice.id,
        version: Number(latest?.version ?? 0) + 1,
        status: 'pending',
        consentRecordedAt,
        consentStatement: statement,
        consentSha256,
        samplePaths: paths,
      },
    })
    await tx.creativeVoiceAudit.create({
      data: {
        voiceId: voice.id,
        voiceVersionId: version.id,
        ownerId: owner,
        action: 'consent_recorded',
        reason: statement,
        metadata: { consentSha256, sampleCount: paths.length },
      },
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
          kind: 'voice_clone',
          samplePaths: paths,
          ownerVoice: true,
          ownerId: owner,
          usageContext: OWNER_STUDIO_USAGE_CONTEXT,
          voiceId: voice.id,
          voiceVersionId: version.id,
          costUsd: costBdt / 125,
          ...(resourceContext
            ? {
                brandProfileId: resourceContext.brandProfileId,
                projectId: resourceContext.projectId,
              }
            : {}),
        },
        summary,
        costEstimate: costBdt / 125,
        status: 'approved',
      },
    })
    if (resourceContext) {
      const scopeRecord = {
        version: 1 as const,
        ownerId: resourceContext.access.ownerId,
        brandProfileId: resourceContext.brandProfileId,
        projectId: resourceContext.projectId,
        createdById: actor.userId,
        createdAt: new Date().toISOString(),
      }
      const scopeKey = studioResourceScopeKey('voice', voice.id)
      await tx.agentKvSetting.upsert({
        where: { key: scopeKey },
        create: { key: scopeKey, value: JSON.stringify(scopeRecord) },
        update: { value: JSON.stringify(scopeRecord) },
      })
    }
    await tx.creativeVoiceAudit.create({
      data: {
        voiceId: voice.id,
        voiceVersionId: version.id,
        ownerId: owner,
        action: 'provider_clone_queued',
        metadata: { pendingActionId: pending.id, provider, estimatedCostBdt: costBdt },
      },
    })
    return { voice, version, pending }
  })

  return Response.json({
    ok: true,
    voiceId: created.voice.id,
    voiceVersionId: created.version.id,
    version: created.version.version,
    pendingActionId: created.pending.id,
    provider,
    costBdt,
    maxCostBdt: gate.capBdt,
  }, { status: 201 })
}

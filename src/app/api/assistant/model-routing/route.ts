/**
 * Owner model-routing control + per-agent daily activity (CCTV "what each agent did today").
 *
 * GET  → current routing config, today's Opus usage vs cap, and a per-provider
 *        breakdown of what each underlying agent/model did today (calls + cost).
 * POST → owner saves routing config (Opus on/off, daily cap, thresholds).
 *
 * Owner-session auth only (this is an owner control surface; the worker reads
 * config directly via prisma, never over HTTP).
 */
import { type NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'
import {
  getModelRoutingConfig,
  setModelRoutingConfig,
  getOpusUsedToday,
  ROUTING_DEFAULTS,
  type ModelRoutingConfig,
} from '@/agent/lib/models/routing-config'
import { getModel, MODEL_REGISTRY } from '@/agent/lib/models/registry'

export const runtime = 'nodejs'

/** Models the owner may pick as the premium escalation target (strong tiers only). */
const ESCALATION_CANDIDATE_IDS = ['claude-opus-4-8', 'gemini-3.1-pro', 'gpt-5.5', 'gpt-5.4']

/** Friendly identity for each underlying provider — the owner's "agents". */
const AGENT_PROFILE: Record<string, { emoji: string; label: string; role: string }> = {
  anthropic: { emoji: '🧠', label: 'হেড এজেন্ট', role: 'Reasoning · chat · decisions (Claude)' },
  google: { emoji: '🎨', label: 'ইমেজ ও ভিডিও', role: 'Image / video generation (Gemini · Veo)' },
  gemini: { emoji: '🎨', label: 'ইমেজ ও ভিডিও', role: 'Image / video generation (Gemini)' },
  openai: { emoji: '🎙️', label: 'ভয়েস (Whisper)', role: 'Voice transcription / embeddings' },
  oxylabs: { emoji: '🔎', label: 'ওয়েব রিসার্চ', role: 'Live web research & scraping' },
  elevenlabs: { emoji: '🗣️', label: 'ভয়েস (TTS)', role: 'Text-to-speech (owner voice)' },
  google_tts: { emoji: '🗣️', label: 'ভয়েস (TTS)', role: 'Text-to-speech (Bangla)' },
  twilio: { emoji: '📞', label: 'কল এজেন্ট', role: 'Emergency phone-call escalation' },
}

function profileFor(provider: string) {
  return AGENT_PROFILE[provider] ?? { emoji: '⚙️', label: provider, role: 'Service' }
}

async function ownerOnly(req: NextRequest): Promise<boolean> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  return !!(token?.sub && isSystemOwner(token))
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await ownerOnly(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const todayStr = todayYmdDhaka()
  const { start, end } = dhakaDayBounds(todayStr)

  const [config, opusUsedToday] = await Promise.all([
    getModelRoutingConfig(),
    getOpusUsedToday(),
  ])

  // Per-provider activity today → the "what each agent did today" CCTV view.
  const providerRows = await prisma.$queryRaw<Array<{ provider: string; calls: bigint; total: string }>>(
    Prisma.sql`SELECT provider, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0)::text AS total
               FROM agent_cost_events
               WHERE occurred_at >= ${start} AND occurred_at < ${end}
               GROUP BY provider
               ORDER BY SUM(cost_usd) DESC`,
  ).catch(() => [] as Array<{ provider: string; calls: bigint; total: string }>)

  const agentsToday = providerRows.map((r) => {
    const p = profileFor(r.provider)
    return {
      provider: r.provider,
      emoji: p.emoji,
      label: p.label,
      role: p.role,
      calls: Number(r.calls) || 0,
      costUsd: parseFloat(r.total) || 0,
    }
  })

  // Which Claude / model variants actually ran owner conversations today.
  const modelRows = await prisma.$queryRaw<Array<{ model: string; conversations: bigint }>>(
    Prisma.sql`SELECT model, COUNT(*) AS conversations
               FROM agent_conversations
               WHERE last_message_at >= ${start} AND last_message_at < ${end}
               GROUP BY model
               ORDER BY COUNT(*) DESC`,
  ).catch(() => [] as Array<{ model: string; conversations: bigint }>)

  const modelsToday = modelRows.map((r) => ({
    modelId: r.model,
    label: getModel(r.model).label,
    conversations: Number(r.conversations) || 0,
  }))

  const criticalModelOptions = ESCALATION_CANDIDATE_IDS.map((id) => {
    const m = getModel(id)
    return { id: m.id, label: m.label, provider: m.provider, inPerM: m.inPerM, outPerM: m.outPerM }
  })
  // Head/default model price for an at-a-glance cost comparison in the UI.
  const headModel = MODEL_REGISTRY.find((m) => m.default) ?? MODEL_REGISTRY[0]

  return Response.json({
    config,
    defaults: ROUTING_DEFAULTS,
    criticalModelOptions,
    headModel: { id: headModel.id, label: headModel.label, inPerM: headModel.inPerM, outPerM: headModel.outPerM },
    opusUsedToday,
    opusRemainingToday: Math.max(0, config.opusDailyCap - opusUsedToday),
    agentsToday,
    modelsToday,
    todayDhakaDate: todayStr,
    asOf: new Date().toISOString(),
  })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!(await ownerOnly(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: Partial<ModelRoutingConfig>
  try {
    body = (await req.json()) as Partial<ModelRoutingConfig>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const patch: Partial<ModelRoutingConfig> = {}
  if (typeof body.opusEnabled === 'boolean') patch.opusEnabled = body.opusEnabled
  if (Number.isFinite(body.opusDailyCap)) patch.opusDailyCap = Number(body.opusDailyCap)
  if (Number.isFinite(body.opusConfidenceThreshold)) patch.opusConfidenceThreshold = Number(body.opusConfidenceThreshold)
  if (Number.isFinite(body.opusCriticalTaka)) patch.opusCriticalTaka = Number(body.opusCriticalTaka)
  if (typeof body.criticalModelId === 'string') patch.criticalModelId = body.criticalModelId

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: 'no_valid_fields' }, { status: 400 })
  }

  await setModelRoutingConfig(patch)
  const config = await getModelRoutingConfig()
  return Response.json({ ok: true, config })
}

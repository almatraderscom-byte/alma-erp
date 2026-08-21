import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { MODEL_REGISTRY, modelsByProvider, DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import { getModelEnabledMap, isModelEnabledSync, setModelEnabled } from '@/agent/lib/models/model-enabled'
import { EFFORT_LABELS } from '@/agent/lib/models/effort'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const enabledMap = await getModelEnabledMap()
  // Worker-only models (headPickable:false — e.g. Gemini 2.5 Flash LITE, GLM 32B)
  // are hidden from every picker (web + native + android all read this route):
  // picked as a head they answer from thin air instead of calling tools
  // (2026-07-12 salah incident). The tier-router still uses them for sub-tasks.
  const pickable = MODEL_REGISTRY.filter((m) => m.headPickable !== false)
  const byProvider = modelsByProvider()
  for (const key of Object.keys(byProvider) as Array<keyof ReturnType<typeof modelsByProvider>>) {
    byProvider[key] = byProvider[key].filter((m) => m.headPickable !== false)
  }
  return Response.json({
    defaultModelId: DEFAULT_MODEL_ID,
    /** Owner-facing labels for the thinking-level row (web + native read the same list). */
    effortOptions: (Object.keys(EFFORT_LABELS) as Array<keyof typeof EFFORT_LABELS>).map((level) => ({
      level,
      label: EFFORT_LABELS[level].en,
      labelBn: EFFORT_LABELS[level].bn,
    })),
    // The thinking-level picker reads `effortLevels` per model and offers ONLY
    // those (see effort.ts): Gemini genuinely has nothing above `high`, Sonnet
    // 4.6 predates `xhigh`, Haiku 4.5 rejects `effort` and runs on a thinking
    // budget instead. Sending one shared list would put a "Max" on models that
    // would 400 on it or silently clamp — a dial that lies about what it does.
    models: pickable.map(({ id, label, provider, supportsCaching, contextWindow, inPerM, outPerM, effort, default: isDefault }) => ({
      id,
      label,
      provider,
      supportsCaching,
      contextWindow,
      inPerM,
      outPerM,
      default: isDefault ?? false,
      enabled: isModelEnabledSync(id, enabledMap),
      effortLevels: effort?.levels ?? [],
      effortDefault: effort?.providerDefault ?? null,
    })),
    byProvider,
  })
}

/** Owner toggle: PATCH { modelId, enabled } — an OFF model is unusable app-wide
 *  (pinned chats included); turns auto-fall-back to Gemini/DeepSeek. */
export async function PATCH(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as { modelId?: string; enabled?: boolean }
  const modelId = String(body.modelId ?? '')
  if (!MODEL_REGISTRY.some((m) => m.id === modelId)) {
    return Response.json({ error: 'unknown_model' }, { status: 400 })
  }
  try {
    const map = await setModelEnabled(modelId, body.enabled !== false)
    return Response.json({ ok: true, enabledMap: map })
  } catch (err) {
    if (err instanceof Error && err.message === 'all_models_disabled') {
      return Response.json({ error: 'অন্তত একটা model ON থাকতেই হবে' }, { status: 400 })
    }
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

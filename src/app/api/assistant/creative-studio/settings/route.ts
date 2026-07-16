// CS4: studio settings the owner flips without a redeploy —
// QC level (agent_qc_level: off/normal/strict, already read worker-side) and
// the Telegram done-ping (studio_notify_on_done). Plus child-garment cache
// management (list/delete) so a bad cached garment can be purged.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { readKv, writeKv, QC_LEVEL_KEY, NOTIFY_KEY, readSceneWeights } from '@/lib/creative-studio/taste'
import {
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  CS_SINGLE_VTON_DEFAULT_KEY,
  SINGLE_VTON_ENGINE_IDS,
  normalizeSingleVtonDefault,
  type StudioEngineId,
} from '@/lib/creative-studio/provider-registry'
import { agentStorageSignedUrls } from '@/agent/lib/storage'

export const runtime = 'nodejs'

const GARMENT_PREFIX = 'tryon_child_garment:'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function GET(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  const [qcLevel, notify, weights, garmentRows, imageModels, falEnabled, idmEnabled, fillEnabled, vtonDefault] = await Promise.all([
    readKv(QC_LEVEL_KEY),
    readKv(NOTIFY_KEY),
    readSceneWeights(),
    db.agentKvSetting.findMany({ where: { key: { startsWith: GARMENT_PREFIX } } }),
    readKv('cs_image_models'),
    readKv(CS_FAL_ENABLED_KEY),
    readKv(CS_IDM_VTON_ENABLED_KEY),
    readKv(CS_FLUX_FILL_ENABLED_KEY),
    readKv(CS_SINGLE_VTON_DEFAULT_KEY),
  ])

  // Image engine — which model family the worker's Gemini-path renders use.
  // 'gpt' when the kv points the pro tier at a gpt-image model, else 'gemini'.
  let imageEngine: 'gemini' | 'gpt' | 'seedream' = 'gemini'
  try {
    const cfg = imageModels ? (JSON.parse(imageModels) as { pro?: string }) : null
    if (cfg?.pro?.startsWith('gpt-image')) imageEngine = 'gpt'
    else if (cfg?.pro?.startsWith('seedream')) imageEngine = 'seedream'
  } catch { /* malformed kv → default */ }

  const garments = (garmentRows as Array<{ key: string; value: string }>).map((r) => {
    const [role, ...rest] = r.key.slice(GARMENT_PREFIX.length).split(':')
    return { key: r.key, role, productPath: rest.join(':'), garmentPath: r.value }
  })
  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(garments.map((g) => g.garmentPath), 3600)
  } catch { /* thumbs optional */ }

  return Response.json({
    qcLevel: qcLevel ?? 'normal',
    notifyOnDone: notify === '1',
    imageEngine,
    sceneWeights: weights,
    childGarments: garments.map((g) => ({ ...g, url: signed[g.garmentPath] ?? null })),
    // CS5 — Fal foundation flags (all default OFF; engines go runnable in CS6/CS7)
    falEnabled: falEnabled === '1',
    idmVtonEnabled: idmEnabled === '1',
    fluxFillEnabled: fillEnabled === '1',
    singleVtonDefault: normalizeSingleVtonDefault(vtonDefault),
  })
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  let body: {
    qcLevel?: string
    notifyOnDone?: boolean
    imageEngine?: string
    falEnabled?: boolean
    idmVtonEnabled?: boolean
    fluxFillEnabled?: boolean
    singleVtonDefault?: string
  }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  if (body.qcLevel && ['off', 'normal', 'strict'].includes(body.qcLevel)) {
    await writeKv(QC_LEVEL_KEY, body.qcLevel)
  }
  if (typeof body.notifyOnDone === 'boolean') {
    await writeKv(NOTIFY_KEY, body.notifyOnDone ? '1' : '0')
  }
  // Image engine switch (owner request 2026-07-12): the worker re-reads the
  // cs_image_models kv before every render, so this applies to the NEXT job —
  // no redeploy. 'gpt' → GPT Image 2 both tiers (worker maps standard→medium,
  // pro→high quality); 'gemini' → delete the kv, back to Nano Banana defaults.
  // FASHN try-on renders are engine-independent and unaffected.
  if (body.imageEngine === 'gpt') {
    await writeKv('cs_image_models', JSON.stringify({ standard: 'gpt-image-2', pro: 'gpt-image-2' }))
  } else if (body.imageEngine === 'seedream') {
    // Seedream 5.0 Pro via fal.ai (worker maps standard→≤1536px band, pro→2K).
    await writeKv('cs_image_models', JSON.stringify({ standard: 'seedream-5.0-pro', pro: 'seedream-5.0-pro' }))
  } else if (body.imageEngine === 'gemini') {
    await db.agentKvSetting.deleteMany({ where: { key: 'cs_image_models' } })
  }
  // CS5 — Fal foundation flags. Owner-tunable, no redeploy. These only gate
  // AVAILABILITY metadata in CS5; nothing becomes runnable before CS6/CS7.
  if (typeof body.falEnabled === 'boolean') {
    await writeKv(CS_FAL_ENABLED_KEY, body.falEnabled ? '1' : '0')
  }
  if (typeof body.idmVtonEnabled === 'boolean') {
    await writeKv(CS_IDM_VTON_ENABLED_KEY, body.idmVtonEnabled ? '1' : '0')
  }
  if (typeof body.fluxFillEnabled === 'boolean') {
    await writeKv(CS_FLUX_FILL_ENABLED_KEY, body.fluxFillEnabled ? '1' : '0')
  }
  if (typeof body.singleVtonDefault === 'string') {
    // Reject anything outside the single-person VTON allowlist (no injection).
    if (!SINGLE_VTON_ENGINE_IDS.includes(body.singleVtonDefault as StudioEngineId)) {
      return Response.json({ error: 'invalid_vton_default' }, { status: 422 })
    }
    await writeKv(CS_SINGLE_VTON_DEFAULT_KEY, body.singleVtonDefault)
  }
  return Response.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied
  const key = req.nextUrl.searchParams.get('key') ?? ''
  if (!key.startsWith(GARMENT_PREFIX)) return Response.json({ error: 'invalid_key' }, { status: 422 })
  await db.agentKvSetting.deleteMany({ where: { key } })
  return Response.json({ ok: true })
}

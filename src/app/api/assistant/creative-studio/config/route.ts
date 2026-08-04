import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isFashnConfigured } from '@/lib/fashn/client'
import { readKv } from '@/lib/creative-studio/taste'
import {
  CS_ENGINE_KILL_PREFIX,
  CS_FAL_ENABLED_KEY,
  CS_FLUX_FILL_ENABLED_KEY,
  CS_IDM_VTON_ENABLED_KEY,
  CS_SINGLE_VTON_DEFAULT_KEY,
  CS_XAI_ENABLED_KEY,
  FAMILY_CHAIN_LABEL_BN,
  describeEngineAvailability,
  normalizeSingleVtonDefault,
} from '@/lib/creative-studio/provider-registry'
import {
  genericImageProvider,
  normalizeGenericImageModels,
} from '@/lib/creative-studio/advanced-image-capabilities'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const fashnConfigured = isFashnConfigured()
  const googleImageConfigured = Boolean(process.env.GEMINI_API_KEY?.trim())
  // Missing FAL_KEY is a truthful availability state (configured:false in the
  // engines list) — never a crash for the FASHN/Gemini modes.
  const falConfigured = Boolean(process.env.FAL_KEY?.trim())
  const xaiConfigured = Boolean(process.env.XAI_API_KEY?.trim())

  const [falEnabled, idmEnabled, fillEnabled, xaiEnabled, vtonDefault, rawImageModels] = await Promise.all([
    readKv(CS_FAL_ENABLED_KEY),
    readKv(CS_IDM_VTON_ENABLED_KEY),
    readKv(CS_FLUX_FILL_ENABLED_KEY),
    readKv(CS_XAI_ENABLED_KEY),
    readKv(CS_SINGLE_VTON_DEFAULT_KEY),
    readKv('cs_image_models'),
  ])
  const genericImageModels = normalizeGenericImageModels(rawImageModels)
  const genericProvider = genericImageProvider(genericImageModels.pro)
  const genericConfigured =
    genericProvider === 'openai'
      ? Boolean(process.env.OPENAI_API_KEY?.trim())
      : genericProvider === 'fal'
        ? falConfigured
        : googleImageConfigured
  // CS12 — per-engine kill switches feed availability truthfully
  const kills: Record<string, boolean> = {}
  for (const id of ['fashn', 'gemini', 'fal_fashn_v16', 'fal_idm_vton', 'fal_flux_fill', 'xai_imagine']) {
    kills[id] = (await readKv(`${CS_ENGINE_KILL_PREFIX}${id}`)) === '1'
  }

  return Response.json({
    fashnConfigured,
    geminiConfigured: genericConfigured,
    veoConfigured: googleImageConfigured,
    genericImageModels,
    genericImageProvider: genericProvider,
    falConfigured,
    xaiConfigured,
    engines: describeEngineAvailability({
      fashnConfigured,
      geminiConfigured: genericConfigured,
      falConfigured,
      xaiConfigured,
      flags: {
        [CS_FAL_ENABLED_KEY]: falEnabled === '1',
        [CS_IDM_VTON_ENABLED_KEY]: idmEnabled === '1',
        [CS_FLUX_FILL_ENABLED_KEY]: fillEnabled === '1',
        [CS_XAI_ENABLED_KEY]: xaiEnabled === '1',
      },
      kills,
    }),
    singleVtonDefault: normalizeSingleVtonDefault(vtonDefault),
    familyChainLabelBn: FAMILY_CHAIN_LABEL_BN,
    organization: 'Alma Traders',
  })
}

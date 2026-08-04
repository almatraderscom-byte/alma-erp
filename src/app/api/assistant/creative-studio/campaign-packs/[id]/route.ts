import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import { isSystemOwner } from '@/lib/roles'
import {
  CampaignPackServiceError,
  getCampaignPack,
  selectCampaignPackDraft,
  type CampaignPackView,
} from '@/lib/creative-studio/campaign-pack-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function ownerId(req: NextRequest): Promise<string | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return token.sub
}

function errorResponse(error: unknown) {
  if (error instanceof CampaignPackServiceError) {
    return Response.json({ error: error.code, message: error.message, ...error.details }, { status: error.status })
  }
  console.error('[campaign-pack] request failed', error)
  return Response.json({ error: 'campaign_pack_failed' }, { status: 500 })
}

async function withPreviewUrls(pack: CampaignPackView): Promise<CampaignPackView> {
  const paths = pack.stages
    .map((stage) => stage.storagePath)
    .filter((path): path is string => Boolean(path))
  let signed: Record<string, string> = {}
  if (paths.length) {
    try {
      signed = await agentStorageSignedUrls([...new Set(paths)], 3600)
    } catch {
      signed = {}
    }
  }
  return {
    ...pack,
    stages: pack.stages.map((stage) => ({
      ...stage,
      previewUrl: stage.storagePath ? signed[stage.storagePath] ?? null : null,
    })),
  }
}
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  try {
    return Response.json({ pack: await withPreviewUrls(await getCampaignPack(owner, params.id)) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  if (input.action !== 'select_draft') {
    return Response.json({ error: 'invalid_action' }, { status: 422 })
  }
  try {
    const pack = await selectCampaignPackDraft(owner, params.id, input)
    return Response.json({ pack: await withPreviewUrls(pack) })
  } catch (error) {
    return errorResponse(error)
  }
}

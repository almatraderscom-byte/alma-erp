import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { CampaignPackContractError } from '@/lib/creative-studio/campaign-pack'
import {
  CampaignPackServiceError,
  createCampaignPack,
  listCampaignPacks,
  previewCampaignPack,
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
    return Response.json({
      error: error.code,
      message: error.message,
      ...error.details,
    }, { status: error.status })
  }
  if (error instanceof CampaignPackContractError) {
    return Response.json({ error: error.code, message: error.message }, { status: 422 })
  }
  console.error('[campaign-packs] request failed', error)
  return Response.json({ error: 'campaign_pack_failed' }, { status: 500 })
}

export async function GET(req: NextRequest) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  try {
    const projectId = req.nextUrl.searchParams.get('projectId')?.trim() || null
    return Response.json({ packs: await listCampaignPacks(owner, projectId) })
  } catch (error) {
    return errorResponse(error)
  }
}
export async function POST(req: NextRequest) {
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
  try {
    if (input.intent !== 'queue') {
      return Response.json(await previewCampaignPack(owner, input))
    }
    const result = await createCampaignPack(owner, input)
    return Response.json(result, { status: result.idempotent ? 200 : 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

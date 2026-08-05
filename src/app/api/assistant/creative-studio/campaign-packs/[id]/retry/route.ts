import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  CampaignPackServiceError,
  retryCampaignPackStage,
} from '@/lib/creative-studio/campaign-pack-service'

export const runtime = 'nodejs'

async function ownerId(req: NextRequest): Promise<string | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return token.sub
}

export async function POST(
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
  try {
    return Response.json({ pack: await retryCampaignPackStage(owner, params.id, body) })
  } catch (error) {
    if (error instanceof CampaignPackServiceError) {
      return Response.json({
        error: error.code,
        message: error.message,
        ...error.details,
      }, { status: error.status })
    }
    console.error('[campaign-pack-retry] request failed', error)
    return Response.json({ error: 'campaign_pack_retry_failed' }, { status: 500 })
  }
}

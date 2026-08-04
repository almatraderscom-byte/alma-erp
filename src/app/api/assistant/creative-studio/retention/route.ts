import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  getStudioRetentionDashboard,
  retentionPolicyErrorResponse,
  saveStudioRetentionPolicy,
} from '@/lib/creative-studio/retention-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function owner(req: NextRequest): Promise<{ userId: string } | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return { userId: String(token.sub) }
}

export async function GET(req: NextRequest) {
  const actor = await owner(req)
  if (actor instanceof Response) return actor
  try {
    return Response.json(await getStudioRetentionDashboard(actor.userId))
  } catch (error) {
    return retentionPolicyErrorResponse(error, 'creative-retention')
  }
}

export async function PATCH(req: NextRequest) {
  const actor = await owner(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const policy = await saveStudioRetentionPolicy(actor.userId, actor.userId, {
      archiveEnabled: typeof body.archiveEnabled === 'boolean'
        ? body.archiveEnabled
        : undefined,
      deleteOriginalsEnabled: typeof body.deleteOriginalsEnabled === 'boolean'
        ? body.deleteOriginalsEnabled
        : undefined,
      retentionDays: body.retentionDays == null ? undefined : Number(body.retentionDays),
      verificationGraceHours: body.verificationGraceHours == null
        ? undefined
        : Number(body.verificationGraceHours),
    })
    return Response.json({
      ...(await getStudioRetentionDashboard(actor.userId)),
      policy,
    })
  } catch (error) {
    return retentionPolicyErrorResponse(error, 'creative-retention')
  }
}

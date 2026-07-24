import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  ContentOsServiceError,
  getProject,
  updateProject,
} from '@/lib/creative-studio/project-service'
import { isLegacyProjectId } from '@/lib/creative-studio/project-contract'

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
  if (error instanceof ContentOsServiceError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  console.error('[creative-project] request failed', error)
  return Response.json({ error: 'content_os_failed' }, { status: 500 })
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  if (isLegacyProjectId(params.id)) {
    return Response.json({ error: 'legacy_readonly' }, { status: 409 })
  }
  try {
    return Response.json({ project: await getProject(owner, params.id) })
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
  if (isLegacyProjectId(params.id)) {
    return Response.json({ error: 'legacy_readonly' }, { status: 409 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    return Response.json({ project: await updateProject(owner, params.id, body) })
  } catch (error) {
    return errorResponse(error)
  }
}

import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  ContentOsServiceError,
  createProject,
  listProjects,
} from '@/lib/creative-studio/project-service'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import { hydrateStudioProjectProducts } from '@/lib/creative-studio/studio-project-product-hydration'

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
  console.error('[creative-projects] request failed', error)
  return Response.json({ error: 'content_os_failed' }, { status: 500 })
}

export async function GET(req: NextRequest) {
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')
  if (brandProfileId) {
    const actor = await authenticateStudioRequest(req)
    if (actor instanceof Response) return actor
    try {
      const access = await requireStudioBrandAccess(actor, brandProfileId)
      const projects = (await listProjects(access.ownerId)).filter((project) =>
        project.brandProfileId === brandProfileId)
      return Response.json(
        { projects: await hydrateStudioProjectProducts(projects) },
        { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
      )
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-projects-list')
    }
  }
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  try {
    return Response.json(
      { projects: await hydrateStudioProjectProducts(await listProjects(owner)) },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
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
  try {
    const [project] = await hydrateStudioProjectProducts([await createProject(owner, body)])
    return Response.json({ project }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}

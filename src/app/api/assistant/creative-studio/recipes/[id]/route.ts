import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import {
  ContentOsServiceError,
  cloneBrandRecipeVersion,
  getBrandRecipe,
  lockBrandRecipe,
  updateBrandRecipe,
} from '@/lib/creative-studio/project-service'

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
  console.error('[creative-recipe] request failed', error)
  return Response.json({ error: 'recipe_failed' }, { status: 500 })
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  try {
    return Response.json({ recipe: await getBrandRecipe(owner, params.id) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const owner = await ownerId(req)
  if (owner instanceof Response) return owner
  let body: Record<string, unknown>
  try {
    const parsed = await req.json()
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  try {
    const recipe = body.action === 'lock'
      ? await lockBrandRecipe(owner, params.id)
      : body.action === 'new_version'
        ? await cloneBrandRecipeVersion(owner, params.id)
        : await updateBrandRecipe(owner, params.id, body)
    return Response.json({ recipe })
  } catch (error) {
    return errorResponse(error)
  }
}

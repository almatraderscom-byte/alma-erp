import { type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  assertStudioCapability,
  authenticateStudioRequest,
  listAccessibleStudioBrands,
  requireStudioBrandAccess,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  try {
    return Response.json({ brands: await listAccessibleStudioBrands(actor) })
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-brands')
  }
}

export async function PATCH(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const brandProfileId = typeof body.brandProfileId === 'string'
    ? body.brandProfileId
    : ''
  if (!brandProfileId) {
    return Response.json({ error: 'brand_profile_id_required' }, { status: 422 })
  }

  try {
    const access = await requireStudioBrandAccess(actor, brandProfileId)
    assertStudioCapability(access.role, 'manage_roles')
    const threshold = Number(body.approvalSpendThresholdBdt)
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 10_000_000) {
      return Response.json({ error: 'invalid_spend_threshold' }, { status: 422 })
    }
    const notes = typeof body.notes === 'string'
      ? body.notes.trim().slice(0, 2_000) || null
      : undefined
    await db.creativeBrandProfile.update({
      where: { id: brandProfileId },
      data: {
        approvalSpendThresholdBdt: threshold,
        ...(notes !== undefined ? { notes } : {}),
      },
    })
    return Response.json({ brands: await listAccessibleStudioBrands(actor) })
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-brands')
  }
}

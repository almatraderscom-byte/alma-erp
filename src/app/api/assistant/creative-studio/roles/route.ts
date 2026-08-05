import { type NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  assertStudioCapability,
  authenticateStudioRequest,
  normalizeAssignableStudioRole,
  requireStudioBrandAccess,
  studioAccessErrorResponse,
  studioRoleToDb,
} from '@/lib/creative-studio/studio-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function serializeAssignment(row: Record<string, unknown>) {
  const user = row.user && typeof row.user === 'object'
    ? row.user as Record<string, unknown>
    : {}
  return {
    id: String(row.id),
    brandProfileId: String(row.brandProfileId),
    userId: String(row.userId),
    userName: String(user.name ?? 'Studio user'),
    userEmail: typeof user.email === 'string' ? user.email : null,
    erpRole: String(user.role ?? 'VIEWER'),
    role: String(row.role).toLowerCase(),
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt),
  }
}

async function ownerTeam(actor: { userId: string; erpRole: string }, brandProfileId: string) {
  const access = await requireStudioBrandAccess(actor as never, brandProfileId)
  assertStudioCapability(access.role, 'manage_roles')
  const [assignments, users] = await Promise.all([
    db.creativeStudioRoleAssignment.findMany({
      where: { brandProfileId, ownerId: access.ownerId },
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.user.findMany({
      where: { active: true, id: { not: access.ownerId } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  ])
  return {
    assignments: assignments.map((row: Record<string, unknown>) => serializeAssignment(row)),
    eligibleUsers: users.map((user: Record<string, unknown>) => ({
      id: String(user.id),
      name: String(user.name),
      email: typeof user.email === 'string' ? user.email : null,
      erpRole: String(user.role),
    })),
  }
}

export async function GET(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId') ?? ''
  if (!brandProfileId) {
    return Response.json({ error: 'brand_profile_id_required' }, { status: 422 })
  }
  try {
    return Response.json(await ownerTeam(actor, brandProfileId))
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-roles')
  }
}

export async function POST(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const brandProfileId = typeof body.brandProfileId === 'string' ? body.brandProfileId : ''
  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!brandProfileId || !userId) {
    return Response.json({ error: 'brand_and_user_required' }, { status: 422 })
  }

  try {
    const access = await requireStudioBrandAccess(actor, brandProfileId)
    assertStudioCapability(access.role, 'manage_roles')
    if (userId === access.ownerId) {
      return Response.json({ error: 'owner_role_is_implicit' }, { status: 422 })
    }
    const role = normalizeAssignableStudioRole(body.role)
    const user = await db.user.findFirst({
      where: { id: userId, active: true },
      select: { id: true },
    })
    if (!user) return Response.json({ error: 'user_not_found' }, { status: 404 })

    await db.creativeStudioRoleAssignment.upsert({
      where: { brandProfileId_userId: { brandProfileId, userId } },
      create: {
        ownerId: access.ownerId,
        brandProfileId,
        userId,
        role: studioRoleToDb(role),
        grantedById: actor.userId,
      },
      update: {
        role: studioRoleToDb(role),
        grantedById: actor.userId,
      },
    })
    return Response.json(await ownerTeam(actor, brandProfileId))
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-roles')
  }
}

export async function DELETE(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const brandProfileId = typeof body.brandProfileId === 'string' ? body.brandProfileId : ''
  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!brandProfileId || !userId) {
    return Response.json({ error: 'brand_and_user_required' }, { status: 422 })
  }
  try {
    const access = await requireStudioBrandAccess(actor, brandProfileId)
    assertStudioCapability(access.role, 'manage_roles')
    await db.creativeStudioRoleAssignment.deleteMany({
      where: { brandProfileId, userId, ownerId: access.ownerId },
    })
    return Response.json(await ownerTeam(actor, brandProfileId))
  } catch (error) {
    return studioAccessErrorResponse(error, 'creative-roles')
  }
}

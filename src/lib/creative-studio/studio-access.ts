import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import { isSystemOwner } from '@/lib/roles'

// Kept structural so access-contract tests do not depend on a just-generated
// Prisma client while the schema and migration are being developed together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const DEFAULT_STUDIO_BRANDS = [
  { name: 'ALMA Lifestyle', organization: 'ALMA Lifestyle' },
  { name: 'ALMA Trading', organization: 'ALMA Trading' },
  { name: 'CDIT', organization: 'Creative Digital IT' },
] as const

export type StudioAccessRole = 'owner' | 'creator' | 'reviewer'
export type StudioAccessCapability =
  | 'draft'
  | 'comment'
  | 'request_changes'
  | 'revise'
  | 'approve'
  | 'manage_roles'

export type StudioActor = {
  userId: string
  name: string
  email: string | null
  erpRole: string
}

export type StudioBrandAccess = {
  brandProfileId: string
  ownerId: string
  role: StudioAccessRole
  approvalSpendThresholdBdt: number
}

export type StudioBrandSummary = StudioBrandAccess & {
  name: string
  organization: string | null
  notes: string | null
  projectCount: number
  recipeCount: number
  assetCount: number
}

export class StudioAccessError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 403, message = code) {
    super(message)
    this.name = 'StudioAccessError'
    this.code = code
    this.status = status
  }
}

const CAPABILITIES: Record<StudioAccessRole, ReadonlySet<StudioAccessCapability>> = {
  owner: new Set(['draft', 'comment', 'request_changes', 'revise', 'approve', 'manage_roles']),
  creator: new Set(['draft', 'revise']),
  reviewer: new Set(['comment', 'request_changes']),
}

function accessRole(value: unknown): StudioAccessRole | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'owner' || normalized === 'creator' || normalized === 'reviewer') {
    return normalized
  }
  return null
}

export function studioRoleToDb(role: StudioAccessRole): 'OWNER' | 'CREATOR' | 'REVIEWER' {
  return role.toUpperCase() as 'OWNER' | 'CREATOR' | 'REVIEWER'
}

export function normalizeAssignableStudioRole(value: unknown): 'creator' | 'reviewer' {
  const role = accessRole(value)
  if (role === 'creator' || role === 'reviewer') return role
  throw new StudioAccessError('invalid_studio_role', 422)
}

export function canStudio(role: StudioAccessRole, capability: StudioAccessCapability): boolean {
  return CAPABILITIES[role].has(capability)
}

export function assertStudioCapability(
  role: StudioAccessRole,
  capability: StudioAccessCapability,
): void {
  if (!canStudio(role, capability)) {
    throw new StudioAccessError(`studio_${capability}_forbidden`, 403)
  }
}

export function assertStudioSpendAllowed(
  role: StudioAccessRole,
  estimatedCostBdt: number,
  approvalSpendThresholdBdt: number,
): void {
  const cost = Math.max(0, roundMoney(Number(estimatedCostBdt) || 0))
  const threshold = Math.max(0, roundMoney(Number(approvalSpendThresholdBdt) || 0))
  if (role === 'owner') return
  if (role !== 'creator' || cost > threshold) {
    throw new StudioAccessError(
      cost > threshold ? 'owner_spend_approval_required' : 'studio_spend_forbidden',
      403,
    )
  }
}

export function assertStudioBrandScope(
  actualBrandProfileId: string | null | undefined,
  requestedBrandProfileId: string | null | undefined,
): void {
  if (!actualBrandProfileId) throw new StudioAccessError('asset_brand_missing', 409)
  if (requestedBrandProfileId && actualBrandProfileId !== requestedBrandProfileId) {
    throw new StudioAccessError('brand_scope_mismatch', 403)
  }
}

export async function authenticateStudioRequest(
  req: NextRequest,
): Promise<StudioActor | Response> {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return {
    userId: String(token.sub),
    name: String(token.name ?? token.email ?? 'Studio user').slice(0, 120),
    email: typeof token.email === 'string' ? token.email.slice(0, 240) : null,
    erpRole: String(token.role ?? 'VIEWER'),
  }
}

export async function ensureDefaultStudioBrands(ownerId: string): Promise<void> {
  await Promise.all(DEFAULT_STUDIO_BRANDS.map((brand) => db.creativeBrandProfile.upsert({
    where: { ownerId_name: { ownerId, name: brand.name } },
    create: {
      ownerId,
      name: brand.name,
      organization: brand.organization,
      approvalSpendThresholdBdt: 0,
    },
    update: {},
  })))
}

function serializeBrand(row: Record<string, unknown>, role: StudioAccessRole): StudioBrandSummary {
  const count = row._count && typeof row._count === 'object'
    ? row._count as Record<string, unknown>
    : {}
  return {
    brandProfileId: String(row.id),
    ownerId: String(row.ownerId),
    role,
    name: String(row.name),
    organization: typeof row.organization === 'string' ? row.organization : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    approvalSpendThresholdBdt: Math.max(0, roundMoney(Number(row.approvalSpendThresholdBdt) || 0)),
    projectCount: Number(count.projects ?? 0),
    recipeCount: Number(count.recipes ?? 0),
    assetCount: Number(count.assets ?? 0),
  }
}

const BRAND_COUNT = {
  projects: true,
  recipes: true,
}

export async function listAccessibleStudioBrands(actor: StudioActor): Promise<StudioBrandSummary[]> {
  if (isSystemOwner(actor.erpRole)) {
    await ensureDefaultStudioBrands(actor.userId)
    const rows = await db.creativeBrandProfile.findMany({
      where: { ownerId: actor.userId },
      include: {
        _count: { select: BRAND_COUNT },
        projects: { select: { _count: { select: { assets: true } } } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    })
    return rows.map((row: Record<string, unknown>) => {
      const projects = Array.isArray(row.projects) ? row.projects : []
      const summary = serializeBrand(row, 'owner')
      summary.assetCount = projects.reduce((total: number, project: unknown) => {
        const projectRow = project && typeof project === 'object'
          ? project as Record<string, unknown>
          : {}
        const count = projectRow._count && typeof projectRow._count === 'object'
          ? projectRow._count as Record<string, unknown>
          : {}
        return total + Number(count.assets ?? 0)
      }, 0)
      return summary
    })
  }

  const rows = await db.creativeStudioRoleAssignment.findMany({
    where: { userId: actor.userId },
    include: {
      brandProfile: {
        include: {
          _count: { select: BRAND_COUNT },
          projects: { select: { _count: { select: { assets: true } } } },
        },
      },
    },
    orderBy: [{ brandProfile: { name: 'asc' } }, { id: 'asc' }],
  })
  return rows.flatMap((assignment: Record<string, unknown>) => {
    const brand = assignment.brandProfile && typeof assignment.brandProfile === 'object'
      ? assignment.brandProfile as Record<string, unknown>
      : null
    const role = accessRole(assignment.role)
    if (!brand || !role || role === 'owner') return []
    const projects = Array.isArray(brand.projects) ? brand.projects : []
    const summary = serializeBrand(brand, role)
    summary.assetCount = projects.reduce((total: number, project: unknown) => {
      const projectRow = project && typeof project === 'object'
        ? project as Record<string, unknown>
        : {}
      const count = projectRow._count && typeof projectRow._count === 'object'
        ? projectRow._count as Record<string, unknown>
        : {}
      return total + Number(count.assets ?? 0)
    }, 0)
    return [summary]
  })
}

export async function requireStudioBrandAccess(
  actor: StudioActor,
  brandProfileId: string,
): Promise<StudioBrandAccess> {
  const brand = await db.creativeBrandProfile.findUnique({
    where: { id: brandProfileId },
    select: {
      id: true,
      ownerId: true,
      approvalSpendThresholdBdt: true,
    },
  })
  if (!brand) throw new StudioAccessError('brand_not_found', 404)

  if (brand.ownerId === actor.userId && isSystemOwner(actor.erpRole)) {
    return {
      brandProfileId: String(brand.id),
      ownerId: String(brand.ownerId),
      role: 'owner',
      approvalSpendThresholdBdt: Math.max(
        0,
        roundMoney(Number(brand.approvalSpendThresholdBdt) || 0),
      ),
    }
  }

  const assignment = await db.creativeStudioRoleAssignment.findUnique({
    where: {
      brandProfileId_userId: {
        brandProfileId,
        userId: actor.userId,
      },
    },
    select: { ownerId: true, role: true },
  })
  const role = accessRole(assignment?.role)
  if (!assignment || !role || role === 'owner' || assignment.ownerId !== brand.ownerId) {
    throw new StudioAccessError('brand_access_forbidden', 403)
  }
  return {
    brandProfileId: String(brand.id),
    ownerId: String(brand.ownerId),
    role,
    approvalSpendThresholdBdt: Math.max(
      0,
      roundMoney(Number(brand.approvalSpendThresholdBdt) || 0),
    ),
  }
}

export function studioAccessErrorResponse(error: unknown, event: string): Response {
  if (error instanceof StudioAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status })
  }
  console.error(`[${event}] request failed`, error)
  return Response.json({ error: 'creative_collaboration_failed' }, { status: 500 })
}

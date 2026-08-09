import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  actor: {
    userId: 'collaborator-1',
    name: 'Collaborator',
    email: 'collaborator@example.com',
    erpRole: 'STAFF',
  },
  token: { sub: 'collaborator-1', role: 'STAFF' },
  project: {
    ownerId: 'owner-1',
    brandProfileId: 'brand-1',
    archivedAt: null,
  },
  authenticate: vi.fn(),
  requireAccess: vi.fn(),
  listProjectAssets: vi.fn(),
  listLegacyAssets: vi.fn(),
  attachProjectAsset: vi.fn(),
  updateProjectAsset: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(async () => mocks.token),
}))

vi.mock('@/agent/lib/guards', () => ({
  requireAgentEnabled: vi.fn(() => null),
}))

vi.mock('@/agent/lib/storage', () => ({
  agentStorageSignedUrls: vi.fn(async () => ({})),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    creativeProject: {
      findUnique: vi.fn(async () => mocks.project),
    },
  },
}))

vi.mock('@/lib/roles', () => ({
  isSystemOwner: vi.fn((role: unknown) => role === 'SUPER_ADMIN'),
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  StudioAccessError: class StudioAccessError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code)
    }
  },
  authenticateStudioRequest: mocks.authenticate,
  requireStudioBrandAccess: mocks.requireAccess,
  studioAccessErrorResponse: vi.fn((error: { code?: string; status?: number }) =>
    Response.json({ error: error.code ?? 'failed' }, { status: error.status ?? 500 })),
}))

vi.mock('@/lib/creative-studio/project-service', () => ({
  ContentOsServiceError: class ContentOsServiceError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code)
    }
  },
  listProjectAssets: mocks.listProjectAssets,
  listLegacyAssets: mocks.listLegacyAssets,
  attachProjectAsset: mocks.attachProjectAsset,
  updateProjectAsset: mocks.updateProjectAsset,
}))

import { GET, PATCH, POST } from '@/app/api/assistant/creative-studio/projects/[id]/assets/route'

function request(method = 'GET') {
  return new NextRequest(
    'https://app.example/api/assistant/creative-studio/projects/project-1/assets',
    method === 'GET'
      ? undefined
      : { method, headers: { 'content-type': 'application/json' }, body: '{}' },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.userId = 'collaborator-1'
  mocks.actor.erpRole = 'STAFF'
  mocks.token.sub = 'collaborator-1'
  mocks.token.role = 'STAFF'
  mocks.project.ownerId = 'owner-1'
  mocks.project.brandProfileId = 'brand-1'
  mocks.project.archivedAt = null
  mocks.authenticate.mockResolvedValue(mocks.actor)
  mocks.requireAccess.mockResolvedValue({
    ownerId: 'owner-1',
    brandProfileId: 'brand-1',
    role: 'creator',
    approvalSpendThresholdBdt: 0,
  })
  mocks.listProjectAssets.mockResolvedValue([])
})

describe('Creative Studio project asset access', () => {
  it('lets an assigned collaborator hydrate assets in the canonical project scope', async () => {
    const response = await GET(request(), { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(mocks.requireAccess).toHaveBeenCalledWith(mocks.actor, 'brand-1')
    expect(mocks.listProjectAssets).toHaveBeenCalledWith('owner-1', 'project-1')
    await expect(response.json()).resolves.toEqual({ assets: [] })
  })

  it('fails closed when the actor is not assigned to the project brand', async () => {
    mocks.requireAccess.mockRejectedValueOnce({
      code: 'brand_access_forbidden',
      status: 403,
    })

    const response = await GET(request(), { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(403)
    expect(mocks.listProjectAssets).not.toHaveBeenCalled()
  })

  it('keeps asset create and update mutations owner-only', async () => {
    const post = await POST(request('POST'), { params: Promise.resolve({ id: 'project-1' }) })
    const patch = await PATCH(request('PATCH'), { params: Promise.resolve({ id: 'project-1' }) })

    expect(post.status).toBe(403)
    expect(patch.status).toBe(403)
    expect(mocks.attachProjectAsset).not.toHaveBeenCalled()
    expect(mocks.updateProjectAsset).not.toHaveBeenCalled()
  })
})

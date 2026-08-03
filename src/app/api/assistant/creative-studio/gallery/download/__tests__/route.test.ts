import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  versionId: 'version-1',
  assetFound: true,
  storagePath: 'generated/original.png',
}))

vi.mock('@/agent/lib/guards', () => ({
  requireAgentEnabled: () => null,
}))

vi.mock('@/agent/lib/drive', () => ({
  fetchDriveFile: vi.fn(),
}))

vi.mock('@/lib/supabase-storage', () => ({
  downloadStorageObject: async () => Buffer.from([137, 80, 78, 71]),
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  StudioAccessError: class StudioAccessError extends Error {
    code: string
    status: number
    constructor(code: string, status: number) {
      super(code)
      this.code = code
      this.status = status
    }
  },
  authenticateStudioRequest: async () => ({
    userId: 'owner-1',
    name: 'Owner',
    email: 'owner@example.com',
    erpRole: 'OWNER',
  }),
  requireStudioBrandAccess: async () => ({ ownerId: 'owner-1', role: 'owner' }),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    creativeProjectAsset: {
      findFirst: async () => state.assetFound
        ? { versions: [{ id: state.versionId }] }
        : null,
    },
    agentPendingAction: {
      findUnique: async () => ({ result: { storagePath: state.storagePath } }),
    },
  },
}))

import { GET } from '@/app/api/assistant/creative-studio/gallery/download/route'

function request(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    id: 'action-1',
    brandProfileId: 'brand-1',
    projectId: 'project-1',
    projectAssetId: 'asset-1',
    assetVersionId: 'version-1',
    reviewSequence: '2',
    ...overrides,
  })
  return new NextRequest(`https://studio.example/api/assistant/creative-studio/gallery/download?${params}`)
}

beforeEach(() => {
  state.versionId = 'version-1'
  state.assetFound = true
  state.storagePath = 'generated/original.png'
})

describe('Creative Studio scoped original download', () => {
  it('returns the exact original bytes as a browser attachment', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(response.headers.get('content-disposition')).toContain('alma-action-1.png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it('rejects a stale asset version instead of downloading a different revision', async () => {
    state.versionId = 'version-2'
    const response = await GET(request())
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'download_asset_snapshot_changed' })
  })

  it('requires the complete project/asset/version snapshot', async () => {
    const response = await GET(new NextRequest(
      'https://studio.example/api/assistant/creative-studio/gallery/download?id=action-1',
    ))
    expect(response.status).toBe(422)
  })
})


import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  sourceImage: 'https://storage.example.supabase.co/storage/v1/object/sign/agent-files/product-images/alma-lifestyle/133-KIDS/1.jpg?token=expired',
  catalogImages: [] as Array<{ id: string; url: string | null; storagePath: string; isPrimary: boolean }>,
  download: vi.fn(async (_path: string) => Buffer.alloc(2048, 1)),
}))

vi.mock('@/agent/lib/storage', () => ({
  agentStorageDownload: mocks.download,
}))

vi.mock('@/lib/creative-studio/studio-access', () => ({
  StudioAccessError: class StudioAccessError extends Error {
    status: number
    code: string
    constructor(code: string, status: number) {
      super(code)
      this.code = code
      this.status = status
    }
  },
  authenticateStudioRequest: vi.fn(async () => ({
    userId: 'owner-1', name: 'Owner', email: null, erpRole: 'SUPER_ADMIN',
  })),
  requireStudioBrandAccess: vi.fn(async () => ({
    ownerId: 'owner-1', brandProfileId: 'brand-1', role: 'owner', approvalSpendThresholdBdt: 0,
  })),
  studioAccessErrorResponse: vi.fn((error: { code?: string; status?: number }) =>
    Response.json({ error: error.code ?? 'failed' }, { status: error.status ?? 500 })),
}))

vi.mock('@/lib/creative-studio/project-service', () => ({
  ContentOsServiceError: class ContentOsServiceError extends Error {
    status: number
    code: string
    constructor(code: string, status: number) {
      super(code)
      this.code = code
      this.status = status
    }
  },
  getProject: vi.fn(async () => ({
    id: 'project-1', name: 'Project', description: null, readonly: false,
    assetCount: 0, brandProfileId: 'brand-1', currentRecipeId: null,
    currentRecipe: null, defaultFolder: 'Unsorted', updatedAt: null,
    product: { code: '133-KIDS', name: '133 Kids', priceBdt: 930, sourceImage: mocks.sourceImage, available: null },
  })),
}))

vi.mock('@/agent/lib/catalog/product-images', () => ({
  listProductImages: vi.fn(async () => mocks.catalogImages),
}))
vi.mock('@/agent/lib/catalog/inventory-lookup', () => ({ DEFAULT_CATALOG_BUSINESS: 'ALMA_LIFESTYLE' }))

import { GET } from '@/app/api/assistant/creative-studio/projects/[id]/product-preview/route'

function request() {
  return new NextRequest(
    'https://app.example/api/assistant/creative-studio/projects/project-1/product-preview?brandProfileId=brand-1',
  )
}

beforeEach(() => {
  mocks.catalogImages = []
  mocks.download.mockReset()
  mocks.download.mockResolvedValue(Buffer.alloc(2048, 1))
})

describe('scoped project product preview', () => {
  it('streams the canonical original with private no-store headers', async () => {
    const response = await GET(request() as never, { params: Promise.resolve({ id: 'project-1' }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect((await response.arrayBuffer()).byteLength).toBe(2048)
    expect(mocks.download).toHaveBeenCalledWith(
      'product-images/alma-lifestyle/133-KIDS/1.jpg',
    )
  })

  it('skips a corrupt canonical object and streams the next healthy catalog image', async () => {
    mocks.catalogImages = [{
      id: 'image-2',
      url: null,
      storagePath: 'product-images/alma-lifestyle/133-KIDS/2.jpg',
      isPrimary: false,
    }]
    mocks.download.mockImplementation(async (path: string) =>
      path.endsWith('/1.jpg') ? Buffer.from('test') : Buffer.alloc(2048, 2))

    const response = await GET(request() as never, { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(200)
    expect((await response.arrayBuffer()).byteLength).toBe(2048)
    expect(mocks.download).toHaveBeenNthCalledWith(
      2,
      'product-images/alma-lifestyle/133-KIDS/2.jpg',
    )
  })

  it('requires an explicit brand scope', async () => {
    const response = await GET(
      new NextRequest('https://app.example/api/assistant/creative-studio/projects/project-1/product-preview'),
      { params: Promise.resolve({ id: 'project-1' }) },
    )
    expect(response.status).toBe(422)
    expect(mocks.download).not.toHaveBeenCalled()
  })
})

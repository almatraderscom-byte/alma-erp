/**
 * Regression: Next 16 hands route handlers a PROMISE for `params`.
 *
 * The 14.2.35 → 16.3.0 bump (3493ab78, 2026-08-09) removed the synchronous
 * compatibility shim, so the old `(ctx as { params: { id } }).params.id` read
 * `undefined`, Prisma rejected `where: { id: undefined }`, and every Approve tap
 * in the iOS app came back as HTTP 500 with nothing approved. These tests pin the
 * awaited read so the id always reaches the query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  getJwt: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { approvalRequest: { findUnique: mocks.findUnique } },
}))
vi.mock('@/lib/api-guards', () => ({
  getJwt: mocks.getJwt,
  requireRoles: vi.fn(async () => null),
  forbidViewerWrite: vi.fn(async () => null),
  validateMutationBusiness: vi.fn(async () => null),
}))

import { GET, PATCH } from '@/app/api/approvals/[id]/route'

/** Exactly what Next 16 passes a route handler. */
const nextCtx = { params: Promise.resolve({ id: 'approval-123' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getJwt.mockResolvedValue({ sub: 'owner-1', role: 'SUPER_ADMIN' })
  mocks.findUnique.mockResolvedValue(null)
})

function patchRequest() {
  return new NextRequest('https://app.example/api/approvals/approval-123', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE' }),
  })
}

describe('approvals/[id] resolves Next 16 async params', () => {
  it('PATCH looks the approval up by the real id — not undefined', async () => {
    const res = await PATCH(patchRequest(), nextCtx)

    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: 'approval-123' } })
    // Unknown approval → a clean 404. The regression produced a 500 here.
    expect(res.status).toBe(404)
  })

  it('GET reads the same awaited id', async () => {
    const res = await GET(
      new NextRequest('https://app.example/api/approvals/approval-123'),
      nextCtx,
    )

    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'approval-123' } }),
    )
    expect(res.status).toBe(404)
  })

  it('a request with no id segment fails as 400, never a 500', async () => {
    const res = await PATCH(patchRequest(), { params: Promise.resolve({}) } as never)

    expect(mocks.findUnique).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
  })
})

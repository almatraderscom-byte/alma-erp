import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  businessAllowed: vi.fn(),
  resolveReferenceEntity: vi.fn(),
}))

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }))
vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/lib/business-access', () => ({ businessAllowed: mocks.businessAllowed }))
vi.mock('@/agent/lib/references/entity-resolver', () => ({
  resolveReferenceEntity: mocks.resolveReferenceEntity,
}))

import { GET } from './route'

const originalRollout = process.env.AGENT_REFERENCES_ROLLOUT
const originalKill = process.env.AGENT_REFERENCES_KILL_SWITCH

function request(query = '') {
  return new NextRequest(`https://alma.test/api/assistant/references/order/ord_1${query}`)
}

function call(namespace = 'order', id = 'ord_1', query = '') {
  return GET(request(query), { params: Promise.resolve({ namespace, id }) })
}

describe('GET provider-neutral exact reference focus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AGENT_REFERENCES_ROLLOUT = 'on'
    delete process.env.AGENT_REFERENCES_KILL_SWITCH
    mocks.getToken.mockResolvedValue({
      sub: 'owner-1', role: 'SUPER_ADMIN', businessAccess: 'ALL',
    })
    mocks.businessAllowed.mockReturnValue(true)
  })

  afterAll(() => {
    if (originalRollout == null) delete process.env.AGENT_REFERENCES_ROLLOUT
    else process.env.AGENT_REFERENCES_ROLLOUT = originalRollout
    if (originalKill == null) delete process.env.AGENT_REFERENCES_KILL_SWITCH
    else process.env.AGENT_REFERENCES_KILL_SWITCH = originalKill
  })

  it('is unavailable in shadow/off mode without touching the entity store', async () => {
    process.env.AGENT_REFERENCES_ROLLOUT = 'shadow'
    const response = await call()
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ state: 'not_found' })
    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(mocks.resolveReferenceEntity).not.toHaveBeenCalled()
  })

  it('returns explicit unauthorized, forbidden role, and forbidden business states', async () => {
    mocks.getToken.mockResolvedValueOnce(null)
    const unauthorized = await call()
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('cache-control')).toBe('private, no-store')
    await expect(unauthorized.json()).resolves.toEqual({ state: 'unauthorized' })

    mocks.getToken.mockResolvedValueOnce({ sub: 'viewer', role: 'VIEWER', businessAccess: 'ALL' })
    const role = await call('cdit_project', 'project_1', '?business_id=CREATIVE_DIGITAL_IT')
    expect(role.status).toBe(403)
    await expect(role.json()).resolves.toEqual({ state: 'forbidden' })

    mocks.businessAllowed.mockReturnValueOnce(false)
    const business = await call('order', 'ord_1', '?business_id=ALMA_LIFESTYLE')
    expect(business.status).toBe(403)
    await expect(business.json()).resolves.toEqual({ state: 'forbidden' })
    expect(mocks.resolveReferenceEntity).not.toHaveBeenCalled()
  })

  it('blocks non-owner roles from owner-global personal records', async () => {
    mocks.getToken.mockResolvedValueOnce({ sub: 'viewer', role: 'VIEWER', businessAccess: 'ALL' })
    const response = await call('bill', 'bill_1')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ state: 'forbidden' })
    expect(mocks.resolveReferenceEntity).not.toHaveBeenCalled()
  })

  it.each([
    ['__proto__', 'ord_1', ''],
    ['unknown_namespace', 'ord_1', ''],
    ['order', '../secret', ''],
    ['order', 'ord_1', '?business_id=UNKNOWN'],
  ])('fails closed for namespace/id/scope %s %s %s', async (namespace, id, query) => {
    const response = await call(namespace, id, query)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ state: 'not_found' })
    expect(mocks.resolveReferenceEntity).not.toHaveBeenCalled()
  })

  it('returns found with a no-store cache boundary and an exact scoped lookup', async () => {
    mocks.resolveReferenceEntity.mockResolvedValue({
      namespace: 'order', id: 'ord_1', title: 'AL-1', label: 'Order',
      status: 'active', businessId: 'ALMA_LIFESTYLE', fallbackPath: 'orders',
      fields: { id: 'ord_1', status: 'open' },
    })
    const response = await call('order', 'ord_1', '?business_id=ALMA_LIFESTYLE')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({
      state: 'found',
      entity: { id: 'ord_1', fallbackPath: '/orders' },
    })
    expect(mocks.resolveReferenceEntity).toHaveBeenCalledWith({
      namespace: 'order', id: 'ord_1', businessId: 'ALMA_LIFESTYLE', userId: 'owner-1',
    })
  })

  it('distinguishes deleted and not-found without mutating data', async () => {
    mocks.resolveReferenceEntity.mockResolvedValueOnce({
      namespace: 'reminder', id: 'rem_1', title: 'Reminder', label: 'Reminder',
      status: 'deleted', businessId: null, fallbackPath: 'agent_home', fields: { id: 'rem_1' },
    })
    const deleted = await call('reminder', 'rem_1')
    expect(deleted.status).toBe(410)
    await expect(deleted.json()).resolves.toMatchObject({ state: 'deleted' })

    mocks.resolveReferenceEntity.mockResolvedValueOnce(null)
    const missing = await call('reminder', 'missing')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ state: 'not_found' })
  })

  it('returns an explicit error state when a read fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.resolveReferenceEntity.mockRejectedValueOnce(new Error('db unavailable'))
    const response = await call('reminder', 'rem_1')
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ state: 'error' })
    consoleError.mockRestore()
  })
})

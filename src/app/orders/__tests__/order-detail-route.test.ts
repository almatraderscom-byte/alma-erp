import { beforeEach, describe, expect, it, vi } from 'vitest'

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }))

vi.mock('next/navigation', () => ({
  redirect: (href: string) => redirectMock(href),
}))

import OrderDetailRoute from '../[id]/page'

describe('/orders/[id]', () => {
  beforeEach(() => redirectMock.mockReset())

  it('redirects the canonical route into exact drawer focus mode', async () => {
    await OrderDetailRoute({ params: Promise.resolve({ id: 'AL/42 বাংলা' }) })

    expect(redirectMock).toHaveBeenCalledOnce()
    expect(redirectMock).toHaveBeenCalledWith('/orders?focus=AL%2F42%20%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE&business_id=ALMA_LIFESTYLE')
  })

  it('preserves an explicit selector so a mismatched route is rejected downstream', async () => {
    await OrderDetailRoute({
      params: Promise.resolve({ id: 'AL-42' }),
      searchParams: Promise.resolve({ business_id: 'ALMA_TRADING' }),
    })

    expect(redirectMock).toHaveBeenCalledWith('/orders?focus=AL-42&business_id=ALMA_TRADING')
  })
})

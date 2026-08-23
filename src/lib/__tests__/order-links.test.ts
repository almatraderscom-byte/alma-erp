import { describe, expect, it } from 'vitest'
import {
  exactFocusedOrder,
  normalizeOrderFocusId,
  orderDetailPath,
  orderFocusIdForBusiness,
  ordersFocusPath,
} from '@/lib/order-links'
import type { Order } from '@/types'

function order(id: string): Order {
  return { id } as Order
}

describe('order deep links', () => {
  it('builds an encoded canonical order route and focus URL', () => {
    expect(orderDetailPath(' AL/42 বাংলা ')).toBe('/orders/AL%2F42%20%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE?business_id=ALMA_LIFESTYLE')
    expect(ordersFocusPath(' AL/42 বাংলা ')).toBe('/orders?focus=AL%2F42%20%E0%A6%AC%E0%A6%BE%E0%A6%82%E0%A6%B2%E0%A6%BE&business_id=ALMA_LIFESTYLE')
  })

  it.each([null, undefined, '', '   ', 'AL-42\nX'])('falls back safely for invalid id %s', (id) => {
    expect(normalizeOrderFocusId(id)).toBeNull()
    expect(orderDetailPath(id)).toBe('/orders')
    expect(ordersFocusPath(id)).toBe('/orders')
  })

  it('accepts only the exact order returned for the focus id', () => {
    expect(exactFocusedOrder('AL-42', order('AL-42'))?.id).toBe('AL-42')
    expect(exactFocusedOrder('AL-42', order('AL-420'))).toBeNull()
    expect(exactFocusedOrder(null, order('AL-42'))).toBeNull()
  })

  it('does not resolve a Lifestyle order focus inside another business context', () => {
    expect(orderFocusIdForBusiness('ALMA_LIFESTYLE', 'AL-42')).toBe('AL-42')
    expect(orderFocusIdForBusiness('ALMA_TRADING', 'AL-42')).toBeNull()
    expect(orderFocusIdForBusiness('CREATIVE_DIGITAL_IT', 'AL-42')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { resolveEntityRouteBusiness, type BusinessId } from '@/lib/businesses'

const all: BusinessId[] = ['ALMA_LIFESTYLE', 'CREATIVE_DIGITAL_IT', 'ALMA_TRADING']

describe('business-scoped entity navigation', () => {
  it.each(['/orders/order-42', '/employees/EMP-42'])(
    'switches an active Trading UI to the trusted Lifestyle record for %s',
    (path) => {
      expect(resolveEntityRouteBusiness(path, 'ALMA_LIFESTYLE', 'ALMA_TRADING', all)).toEqual({
        kind: 'authorized',
        businessId: 'ALMA_LIFESTYLE',
        shouldSwitch: true,
      })
    },
  )

  it('switches the inverse Lifestyle UI to an exact Trading account', () => {
    expect(resolveEntityRouteBusiness(
      '/trading/accounts/acct-9',
      'ALMA_TRADING',
      'ALMA_LIFESTYLE',
      all,
    )).toEqual({ kind: 'authorized', businessId: 'ALMA_TRADING', shouldSwitch: true })
  })

  it('rejects cross-business route/query pairings before an exact fetch', () => {
    expect(resolveEntityRouteBusiness(
      '/orders/order-42',
      'ALMA_TRADING',
      'ALMA_LIFESTYLE',
      all,
    )).toEqual({ kind: 'invalid' })
    expect(resolveEntityRouteBusiness(
      '/trading/accounts/acct-9',
      'ALMA_LIFESTYLE',
      'ALMA_TRADING',
      all,
    )).toEqual({ kind: 'invalid' })
  })

  it('treats the selector as a target, never authorization', () => {
    expect(resolveEntityRouteBusiness(
      '/employees/EMP-42',
      'ALMA_LIFESTYLE',
      'ALMA_TRADING',
      ['ALMA_TRADING'],
    )).toEqual({ kind: 'forbidden', businessId: 'ALMA_LIFESTYLE' })
  })

  it('does not scope shared lists, and scopes /orders only with exact focus', () => {
    expect(resolveEntityRouteBusiness('/employees', 'ALMA_LIFESTYLE', 'ALMA_TRADING', all))
      .toEqual({ kind: 'not_entity' })
    expect(resolveEntityRouteBusiness('/orders', 'ALMA_LIFESTYLE', 'ALMA_TRADING', all))
      .toEqual({ kind: 'not_entity' })
    expect(resolveEntityRouteBusiness(
      '/orders',
      'ALMA_LIFESTYLE',
      'ALMA_TRADING',
      all,
      { hasExactEntityFocus: true },
    )).toEqual({ kind: 'authorized', businessId: 'ALMA_LIFESTYLE', shouldSwitch: true })
  })

  it('keeps legacy detail links valid without inventing a cross-business target', () => {
    expect(resolveEntityRouteBusiness('/employees/EMP-42', null, 'ALMA_TRADING', all))
      .toEqual({ kind: 'legacy', expectedBusinessId: 'ALMA_LIFESTYLE' })
  })
})

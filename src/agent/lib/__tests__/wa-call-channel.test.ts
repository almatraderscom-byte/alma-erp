import { describe, it, expect, afterEach } from 'vitest'
import { waDialAddress, dialAddresses } from '../voice-call'

describe('WhatsApp live-call channel addressing', () => {
  afterEach(() => { delete process.env.TWILIO_WHATSAPP_FROM })

  it('waDialAddress prefixes once, idempotent', () => {
    expect(waDialAddress('+8801884308343')).toBe('whatsapp:+8801884308343')
    expect(waDialAddress('whatsapp:+8801884308343')).toBe('whatsapp:+8801884308343')
  })

  it('phone channel keeps plain PSTN addressing', () => {
    const a = dialAddresses('phone', '+8801711111111', '+15005550006')
    expect(a).toEqual({ to: '+8801711111111', from: '+15005550006' })
  })

  it('whatsapp channel uses whatsapp: on both legs with the business WA number', () => {
    process.env.TWILIO_WHATSAPP_FROM = '+15005550006'
    const a = dialAddresses('whatsapp', '+8801711111111', '+19999999999')
    expect(a).toEqual({ to: 'whatsapp:+8801711111111', from: 'whatsapp:+15005550006' })
  })

  it('whatsapp channel tolerates an already-prefixed env value', () => {
    process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+15005550006'
    const a = dialAddresses('whatsapp', '+8801711111111', '+19999999999')
    expect(a.from).toBe('whatsapp:+15005550006')
  })
})

describe('owner-number role detection (identity-aware calls)', () => {
  afterEach(() => { delete process.env.OWNER_PHONE_NUMBERS })

  it('matches the owner number in any spelling (+880 / 0 prefix)', async () => {
    const { isOwnerNumber } = await import('../voice-call')
    process.env.OWNER_PHONE_NUMBERS = '+8801779640373'
    expect(isOwnerNumber('+8801779640373')).toBe(true)
    expect(isOwnerNumber('01779640373')).toBe(true)
    expect(isOwnerNumber('8801779640373')).toBe(true)
  })

  it('does not match other numbers, and empty env matches nothing', async () => {
    const { isOwnerNumber } = await import('../voice-call')
    process.env.OWNER_PHONE_NUMBERS = '+8801779640373'
    expect(isOwnerNumber('+8801884308343')).toBe(false)
    delete process.env.OWNER_PHONE_NUMBERS
    expect(isOwnerNumber('+8801779640373')).toBe(false)
  })

  it('supports a comma list', async () => {
    const { isOwnerNumber } = await import('../voice-call')
    process.env.OWNER_PHONE_NUMBERS = '+8801779640373, 01311111111'
    expect(isOwnerNumber('+8801311111111')).toBe(true)
  })
})

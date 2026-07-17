import { describe, expect, it } from 'vitest'
import { BKASH_APP_URL, extractTrxIdFromText } from '@/lib/bkash-send-flow'

describe('BKASH_APP_URL', () => {
  // The predecessor `bkash://` was a guess and gave the owner Safari's "address is
  // invalid" (2026-07-17). bKash's own apple-app-site-association publishes a
  // Universal Link instead, which is the only opener we have evidence for:
  // {"applinks":{"details":[{"appID":"4XPYVR2AGK.com.bKash.customerapp","paths":["/next"]}]}}
  it('is the Universal Link bKash publishes, never a guessed custom scheme', () => {
    expect(BKASH_APP_URL).toBe('https://bka.sh/next')
    expect(BKASH_APP_URL.startsWith('https://')).toBe(true)
  })
})

describe('extractTrxIdFromText', () => {
  it('finds a TrxID inside the full bKash SMS/receipt text', () => {
    expect(
      extractTrxIdFromText('Send Money Tk 5,000.00 to 01712345678 successful. Fee Tk 5.00. TrxID BFJ90KAL2M at 17/07/2026'),
    ).toBe('BFJ90KAL2M')
  })

  it('accepts a bare copied TrxID, case-insensitively', () => {
    expect(extractTrxIdFromText('bfj90kal2m')).toBe('BFJ90KAL2M')
    expect(extractTrxIdFromText('  BFJ90KAL2M  ')).toBe('BFJ90KAL2M')
  })

  it('rejects an 11-digit phone number (the recipient number we copied on the way out)', () => {
    expect(extractTrxIdFromText('01712345678')).toBeNull()
  })

  it('rejects 10-letter words with no digit', () => {
    expect(extractTrxIdFromText('SUCCESSFUL payment done')).toBeNull()
  })

  it('rejects amounts and short ids', () => {
    expect(extractTrxIdFromText('5000.00')).toBeNull()
    expect(extractTrxIdFromText('ABC123')).toBeNull()
    expect(extractTrxIdFromText('')).toBeNull()
    expect(extractTrxIdFromText(null)).toBeNull()
  })

  it('does not match a 10-char run embedded in a longer token', () => {
    expect(extractTrxIdFromText('X1BFJ90KAL2MZZ')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { numberToBanglaWords, normalizeForTts } from '../tts-normalize'

describe('numberToBanglaWords', () => {
  it('reads 0', () => {
    expect(numberToBanglaWords(0)).toBe('শূন্য')
  })

  it('reads 7', () => {
    expect(numberToBanglaWords(7)).toBe('সাত')
  })

  it('reads 21 (একুশ)', () => {
    expect(numberToBanglaWords(21)).toBe('একুশ')
  })

  it('reads 79 (ঊনআশি)', () => {
    expect(numberToBanglaWords(79)).toBe('ঊনআশি')
  })

  it('reads 100', () => {
    expect(numberToBanglaWords(100)).toBe('একশো')
  })

  it('reads 205', () => {
    expect(numberToBanglaWords(205)).toBe('দুইশো পাঁচ')
  })

  it('reads 1250', () => {
    expect(numberToBanglaWords(1250)).toBe('এক হাজার দুইশো পঞ্চাশ')
  })

  it('reads 12500', () => {
    expect(numberToBanglaWords(12500)).toBe('বারো হাজার পাঁচশো')
  })

  it('reads 105000 as এক লাখ পাঁচ হাজার', () => {
    expect(numberToBanglaWords(105000)).toBe('এক লাখ পাঁচ হাজার')
  })

  it('reads 12345678 as এক কোটি তেইশ লাখ পঁয়তাল্লিশ হাজার ছয়শো আটাত্তর', () => {
    expect(numberToBanglaWords(12345678)).toBe(
      'এক কোটি তেইশ লাখ পঁয়তাল্লিশ হাজার ছয়শো আটাত্তর',
    )
  })

  it('reads negatives with মাইনাস', () => {
    expect(numberToBanglaWords(-5)).toBe('মাইনাস পাঁচ')
  })

  it('reads decimals digit-by-digit after দশমিক', () => {
    expect(numberToBanglaWords(3.42)).toBe('তিন দশমিক চার দুই')
  })
})

describe('normalizeForTts', () => {
  it('reads $3.42 as তিন দশমিক চার দুই ডলার', () => {
    expect(normalizeForTts('$3.42')).toBe('তিন দশমিক চার দুই ডলার')
  })

  it('reads 4.2% as চার দশমিক দুই শতাংশ', () => {
    expect(normalizeForTts('4.2%')).toBe('চার দশমিক দুই শতাংশ')
  })

  it('reads ৳1,250 as এক হাজার দুইশো পঞ্চাশ টাকা', () => {
    expect(normalizeForTts('৳1,250')).toBe('এক হাজার দুইশো পঞ্চাশ টাকা')
  })

  it('reads "1250 টাকা" without doubling the টাকা word', () => {
    expect(normalizeForTts('1250 টাকা')).toBe('এক হাজার দুইশো পঞ্চাশ টাকা')
  })

  it('normalizes a mixed sentence', () => {
    const input = 'SUI এখন $3.42, গত 24 ঘণ্টায় 4.2% বেড়েছে।'
    expect(normalizeForTts(input)).toBe(
      'সুই এখন তিন দশমিক চার দুই ডলার, গত চব্বিশ ঘণ্টায় চার দশমিক দুই শতাংশ বেড়েছে।',
    )
  })

  it('reads a phone number digit-by-digit', () => {
    expect(normalizeForTts('01712345678')).toBe(
      'শূন্য এক সাত এক দুই তিন চার পাঁচ ছয় সাত আট',
    )
  })

  it('reads time 4:50 as চারটা পঞ্চাশ', () => {
    expect(normalizeForTts('4:50')).toBe('চারটা পঞ্চাশ')
  })

  it('applies known-term phonetic map', () => {
    expect(normalizeForTts('Facebook')).toBe('ফেসবুক')
    expect(normalizeForTts('almatraders.com')).toBe('আলমাট্রেডার্স ডট কম')
  })

  it('leaves a pure-Bangla sentence untouched', () => {
    const input = 'আজকে আবহাওয়া অনেক সুন্দর এবং আকাশ পরিষ্কার।'
    expect(normalizeForTts(input)).toBe(input)
  })

  it('is idempotent', () => {
    const input = 'SUI এখন $3.42, গত 24 ঘণ্টায় 4.2% বেড়েছে।'
    const once = normalizeForTts(input)
    expect(normalizeForTts(once)).toBe(once)
  })

  it('never throws and returns input on non-string', () => {
    // @ts-expect-error deliberately passing a non-string
    expect(normalizeForTts(null)).toBe(null)
  })
})

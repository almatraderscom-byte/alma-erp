import { describe, expect, it } from 'vitest'
import { referencesOtherConversation, shouldSuppressCrossSurfaceForImage } from '@/agent/lib/cross-surface'

describe('explicit cross-chat references', () => {
  it.each([
    'Create a poster based on the campaign we finalized in the other chat.',
    'Use the previous conversation to make this image.',
    'Create a poster based on the campaign in a different chat.',
    'Generate an image using the design from a separate conversation.',
    'আগের চ্যাটের campaign দিয়ে poster বানাও।',
    'আলাদা চ্যাটের campaign দিয়ে poster বানাও।',
    'ager chat er design diye image banao',
  ])('keeps recall for %s', (prompt) => {
    expect(referencesOtherConversation(prompt)).toBe(true)
  })

  it.each([
    'Create three separate visual variations of an ALMA AI poster.',
    'Make another one.',
    'Earlier today, make a poster for the launch.',
    'Use the earlier draft in this chat.',
  ])('does not import unrelated chats for %s', (prompt) => {
    expect(referencesOtherConversation(prompt)).toBe(false)
  })

  it('suppresses recall for a noun-less continuation of a pinned image workflow', () => {
    expect(shouldSuppressCrossSurfaceForImage('make another one', 'alma-image-generation')).toBe(true)
  })

  it('retains recall when a pinned image continuation explicitly names another chat', () => {
    expect(shouldSuppressCrossSurfaceForImage(
      'make another one from the separate conversation',
      'alma-image-generation',
    )).toBe(false)
  })
})

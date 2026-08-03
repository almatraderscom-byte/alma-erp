import { describe, expect, it } from 'vitest'
import { NEGATIVE_DIRECTIVES, buildTryOnPrompt } from '../art-director'

describe('production try-on fidelity prompt', () => {
  it('forbids invented body art and preserves exact garment/model attributes', () => {
    const prompt = buildTryOnPrompt({
      garmentType: 'panjabi',
      modelNotes: 'adult Bangladeshi father',
      extra: 'warm premium studio',
    })
    expect(prompt).toContain('GARMENT FIDELITY (99% rule)')
    expect(prompt).toContain("MODEL IDENTITY")
    expect(prompt).toContain('adding tattoos, body art, scars')
    expect(prompt).toContain('warm premium studio')
    expect(NEGATIVE_DIRECTIVES).toContain('skin markings')
  })
})

import { describe, expect, it } from 'vitest'
import {
  assertRecipeMutable,
  buildRecipeSnapshot,
  nextRecipeVersion,
  normalizeBrandRecipeInput,
  recipeKeyFor,
} from '@/lib/creative-studio/brand-recipe'

describe('CSE3 owner-locked brand recipes', () => {
  it('normalizes every governed recipe field and whole-taka spend', () => {
    const input = normalizeBrandRecipeInput({
      brandName: 'ALMA Lifestyle',
      name: ' Eid Premium ',
      sceneSubset: 'rooftop, warm studio, rooftop',
      modelRoles: ['father', 'son', 'unknown'],
      finishTheme: 'gold',
      captionTone: 'warm Bangla',
      aspectPack: ['4:5', '9:16', '3:2'],
      musicVibe: 'festive',
      qcLevel: 'strict',
      spendCeilingBdt: 499.7,
    })

    expect(input).toMatchObject({
      name: 'Eid Premium',
      sceneSubset: ['rooftop', 'warm studio'],
      modelRoles: ['father', 'son'],
      finishTheme: 'gold',
      captionTone: 'warm Bangla',
      aspectPack: ['4:5', '9:16'],
      musicVibe: 'festive',
      qcLevel: 'strict',
      spendCeilingBdt: 500,
    })
    expect(recipeKeyFor(input)).toBe('eid-premium')
  })

  it('makes a locked version immutable and advances through a new version', () => {
    expect(() => assertRecipeMutable({ lockedAt: new Date() })).toThrowError('recipe_locked')
    expect(() => assertRecipeMutable({ lockedAt: null })).not.toThrow()
    expect(nextRecipeVersion({ version: 3 })).toBe(4)
  })

  it('builds the immutable lineage snapshot attached to an asset version', () => {
    expect(buildRecipeSnapshot({
      id: 'recipe-1',
      recipeKey: 'eid',
      version: 2,
      name: 'Eid',
      sceneSubset: ['studio'],
      modelRoles: ['single'],
      finishTheme: 'gold',
      captionTone: 'premium',
      aspectPack: ['4:5'],
      musicVibe: 'festive',
      qcLevel: 'strict',
      spendCeilingBdt: 500,
    })).toMatchObject({
      id: 'recipe-1',
      version: 2,
      qcLevel: 'strict',
      spendCeilingBdt: 500,
    })
  })
})

/**
 * P5 recipe learning — kv-backed learned recipes: save/refresh, cap+eviction,
 * replay build, and the guarantee that learned runs still go through the same
 * normalize/approval pipeline (run path is exercised in browser-recipe tools).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const kv = vi.hoisted(() => ({ value: null as string | null }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findUnique: vi.fn(async () => (kv.value === null ? null : { value: kv.value })),
      upsert: vi.fn(async (args: { create: { value: string } }) => {
        kv.value = args.create.value
        return {}
      }),
    },
  },
}))

import {
  saveLearnedRecipe,
  listLearnedRecipes,
  buildLearnedRecipeTask,
  slugifyRecipeId,
} from '@/agent/lib/browser/learned-recipes'

beforeEach(() => {
  kv.value = null
})

const baseRecipe = {
  title: 'Daraz price check',
  description: 'দারাজে একটা প্রোডাক্টের দাম দেখা',
  site: 'daraz.com.bd',
  goal: 'check daraz price',
  startUrl: 'https://www.daraz.com.bd/',
  steps: [{ action: 'goto', url: 'https://www.daraz.com.bd/' }, { action: 'extract', what: 'text' }],
}

describe('learned recipes', () => {
  it('saves, lists and replays the proven steps', async () => {
    const saved = await saveLearnedRecipe(baseRecipe)
    expect(saved.ok).toBe(true)
    const id = saved.ok ? saved.id : ''
    expect(id).toMatch(/^learned:/)

    const list = await listLearnedRecipes()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('Daraz price check')

    const built = await buildLearnedRecipeTask(id)
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.built.goal).toBe('check daraz price')
      expect(built.built.steps).toHaveLength(2)
      expect(built.built.startUrl).toBe('https://www.daraz.com.bd/')
    }
    // replay bumped the use counter
    expect((await listLearnedRecipes())[0].uses).toBe(1)
  })

  it('same title = refresh, not a duplicate', async () => {
    await saveLearnedRecipe(baseRecipe)
    await saveLearnedRecipe({ ...baseRecipe, steps: [{ action: 'goto', url: 'https://www.daraz.com.bd/new' }] })
    const list = await listLearnedRecipes()
    expect(list).toHaveLength(1)
    expect(list[0].steps).toHaveLength(1)
  })

  it('rejects empty steps (a learned recipe must carry the steps that worked)', async () => {
    const res = await saveLearnedRecipe({ ...baseRecipe, steps: [] })
    expect(res.ok).toBe(false)
  })

  it('caps the store and evicts the least-used entry', async () => {
    for (let i = 0; i < 40; i++) {
      await saveLearnedRecipe({ ...baseRecipe, title: `recipe ${i}` })
    }
    // use recipe 0 so it is NOT the eviction candidate
    await buildLearnedRecipeTask(slugifyRecipeId('recipe 0'))
    await saveLearnedRecipe({ ...baseRecipe, title: 'one more' })
    const list = await listLearnedRecipes()
    expect(list).toHaveLength(40)
    expect(list.some((r) => r.title === 'one more')).toBe(true)
    expect(list.some((r) => r.title === 'recipe 0')).toBe(true)
  })

  it('unknown id fails loudly', async () => {
    const built = await buildLearnedRecipeTask('learned:nope')
    expect(built.ok).toBe(false)
  })
})

/**
 * P5 recipe learning (roadmap P5): a browser task that COMPLETED successfully
 * gets distilled into a reusable recipe — next time the same job repeats the
 * PROVEN steps instead of re-deriving them. This is how "bhul na kora"
 * compounds over time.
 *
 * Learned recipes live in kv (`agent_kv_settings`, owner-tunable/no-redeploy,
 * capped) beside the code-defined recipes in recipes.ts. They store the exact
 * literal steps that worked (deterministic replay — no param templating in v1)
 * and run through the SAME normalize + owner-approval pipeline as every other
 * browser task; learning a recipe never bypasses a gate.
 */
import { prisma } from '@/lib/prisma'
import type { BuiltRecipe } from './recipes'

export const LEARNED_RECIPES_KV_KEY = 'learned_browser_recipes'
const MAX_LEARNED = 40

export type LearnedRecipe = {
  id: string
  title: string
  description: string
  site: string
  goal: string
  startUrl?: string
  /** the exact steps that WORKED (BrowserStep-shaped; re-validated on run) */
  steps: Array<Record<string, unknown>>
  learnedAt: string
  uses: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function readAll(): Promise<Record<string, LearnedRecipe>> {
  try {
    const row = await db.agentKvSetting.findUnique({
      where: { key: LEARNED_RECIPES_KV_KEY },
      select: { value: true },
    })
    const parsed = row?.value ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeAll(map: Record<string, LearnedRecipe>): Promise<void> {
  const value = JSON.stringify(map)
  await db.agentKvSetting.upsert({
    where: { key: LEARNED_RECIPES_KV_KEY },
    create: { key: LEARNED_RECIPES_KV_KEY, value },
    update: { value },
  })
}

export function slugifyRecipeId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9ঀ-৿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `learned:${slug || 'recipe'}`
}

/**
 * Save (or refresh) a learned recipe. Same id = update (a re-proven run
 * refreshes the steps). The store is capped: when full, the least-used oldest
 * entry is evicted first.
 */
export async function saveLearnedRecipe(input: {
  title: string
  description: string
  site: string
  goal: string
  startUrl?: string
  steps: Array<Record<string, unknown>>
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = input.title.trim()
  if (!title) return { ok: false, error: 'title required' }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'steps required — a learned recipe stores the steps that actually worked' }
  }
  if (input.steps.length > 30) return { ok: false, error: 'too many steps (max 30)' }

  const id = slugifyRecipeId(title)
  const map = await readAll()

  if (!map[id] && Object.keys(map).length >= MAX_LEARNED) {
    const evict = Object.values(map).sort(
      (a, b) => a.uses - b.uses || a.learnedAt.localeCompare(b.learnedAt),
    )[0]
    if (evict) delete map[evict.id]
  }

  map[id] = {
    id,
    title,
    description: input.description.trim().slice(0, 300),
    site: input.site.trim().slice(0, 80),
    goal: input.goal.trim().slice(0, 200),
    startUrl: input.startUrl?.trim() || undefined,
    steps: input.steps,
    learnedAt: new Date().toISOString(),
    uses: map[id]?.uses ?? 0,
  }
  await writeAll(map)
  return { ok: true, id }
}

export async function listLearnedRecipes(): Promise<LearnedRecipe[]> {
  const map = await readAll()
  return Object.values(map).sort((a, b) => b.uses - a.uses || b.learnedAt.localeCompare(a.learnedAt))
}

export async function getLearnedRecipe(id: string): Promise<LearnedRecipe | null> {
  const map = await readAll()
  return map[id] ?? null
}

/** Build the replayable task from a learned recipe + bump its use counter. */
export async function buildLearnedRecipeTask(
  id: string,
): Promise<{ ok: true; built: BuiltRecipe } | { ok: false; error: string }> {
  const map = await readAll()
  const recipe = map[id]
  if (!recipe) return { ok: false, error: `learned recipe not found: ${id}` }
  recipe.uses += 1
  await writeAll(map).catch(() => {}) // counter is best-effort
  return {
    ok: true,
    built: {
      goal: recipe.goal,
      // steps are re-validated by normalizeBrowserTask on every run
      steps: recipe.steps as unknown as BuiltRecipe['steps'],
      startUrl: recipe.startUrl,
    },
  }
}

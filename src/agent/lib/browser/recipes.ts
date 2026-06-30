/**
 * Phase B (site recipes) — reusable, named browser-task templates.
 *
 * Phase A lets the agent hand-craft a list of browser steps. That works, but the
 * head model has to re-figure selectors / URL patterns every time. A RECIPE
 * encodes that knowledge once: the agent picks a recipe by id, fills a few
 * plain-language params, and the recipe expands into the same BrowserStep[] that
 * the Phase A browser-service already executes.
 *
 * Design rules (keep it safe + robust):
 *   • Recipes prefer URL-param navigation + full-text extract + screenshot over
 *     brittle CSS selectors, so they keep working when a site tweaks its markup.
 *   • A recipe NEVER bypasses approval — run_browser_recipe builds the steps then
 *     goes through the exact same normalize + pending-action + kill-switch path as
 *     run_browser_task. Recipes are convenience, not extra privilege.
 *   • No credential persistence; recipes that would need a login are omitted in
 *     this phase (they belong to a later, vault-backed phase).
 */
import type { BrowserStep } from './actions'

export interface RecipeParam {
  name: string
  /** Bangla label shown to the owner / used by the head model. */
  label: string
  required: boolean
  /** Example value to guide the head model. */
  example?: string
}

export interface BuiltRecipe {
  goal: string
  steps: BrowserStep[]
  startUrl?: string
}

export interface BrowserRecipe {
  id: string
  /** Short Bangla title. */
  title: string
  /** What it does (Bangla, owner-facing). */
  description: string
  /** Human label for the target site/domain. */
  site: string
  params: RecipeParam[]
  /** Best-effort recipes rely on a site's live markup and may need a tweak. */
  bestEffort?: boolean
  build: (args: Record<string, string>) => BuiltRecipe
}

function enc(v: string): string {
  return encodeURIComponent(v.trim())
}

/** Standard tail every read-only recipe shares: settle, read, capture. */
function readAndCapture(): BrowserStep[] {
  return [
    { action: 'wait', ms: 2500 },
    { action: 'extract', what: 'text' },
    { action: 'screenshot' },
  ]
}

const RECIPE_LIST: BrowserRecipe[] = [
  {
    id: 'web_search',
    title: 'ওয়েব সার্চ',
    description: 'Google-এ একটা প্রশ্ন সার্চ করে উপরের ফলাফলগুলো পড়ে এনে দেয়।',
    site: 'google.com',
    params: [{ name: 'query', label: 'যা সার্চ করবেন', required: true, example: 'best winter jacket price bd' }],
    build: (a) => ({
      goal: `Google সার্চ: ${a.query}`,
      steps: [{ action: 'goto', url: `https://www.google.com/search?q=${enc(a.query)}&hl=en` }, ...readAndCapture()],
    }),
  },
  {
    id: 'open_page',
    title: 'পেজ খুলে পড়া',
    description: 'যেকোনো একটা লিংক খুলে পুরো লেখা পড়ে এনে দেয় + স্ক্রিনশট নেয়।',
    site: 'যেকোনো সাইট',
    params: [{ name: 'url', label: 'লিংক (http/https)', required: true, example: 'https://example.com/page' }],
    build: (a) => ({
      goal: `পেজ পড়া: ${a.url}`,
      steps: [{ action: 'goto', url: a.url.trim() }, ...readAndCapture()],
    }),
  },
  {
    id: 'price_check',
    title: 'দাম দেখা',
    description: 'একটা প্রোডাক্ট পেজ খুলে দাম/তথ্য পড়ে এনে দেয় (স্ক্রিনশটসহ)।',
    site: 'যেকোনো শপ/প্রোডাক্ট পেজ',
    params: [{ name: 'url', label: 'প্রোডাক্ট লিংক', required: true, example: 'https://www.daraz.com.bd/products/...' }],
    bestEffort: true,
    build: (a) => ({
      goal: `দাম দেখা: ${a.url}`,
      steps: [{ action: 'goto', url: a.url.trim() }, ...readAndCapture()],
    }),
  },
  {
    id: 'currency_rate',
    title: 'মুদ্রার রেট',
    description: 'এক মুদ্রা থেকে আরেক মুদ্রার বর্তমান রেট দেখে এনে দেয় (যেমন USD → BDT)।',
    site: 'google.com',
    params: [
      { name: 'from', label: 'কোন মুদ্রা থেকে', required: true, example: 'USD' },
      { name: 'to', label: 'কোন মুদ্রায়', required: false, example: 'BDT' },
    ],
    build: (a) => {
      const to = (a.to || 'BDT').trim()
      return {
        goal: `মুদ্রার রেট: 1 ${a.from} → ${to}`,
        steps: [{ action: 'goto', url: `https://www.google.com/search?q=${enc(`1 ${a.from} to ${to}`)}&hl=en` }, ...readAndCapture()],
      }
    },
  },
  {
    id: 'track_parcel',
    title: 'পার্সেল ট্র্যাক',
    description:
      'কুরিয়ারের ট্র্যাকিং লিংক খুলে ডেলিভারির অবস্থা পড়ে এনে দেয়। ট্র্যাকিং পেজের পুরো লিংকটা দিন (যেটাতে কনসাইনমেন্ট আইডি বসানো আছে)।',
    site: 'কুরিয়ার ট্র্যাকিং পেজ',
    params: [
      { name: 'trackingUrl', label: 'ট্র্যাকিং লিংক', required: true, example: 'https://steadfast.com.bd/t/ABC123' },
    ],
    bestEffort: true,
    build: (a) => ({
      goal: `পার্সেল ট্র্যাক: ${a.trackingUrl}`,
      steps: [{ action: 'goto', url: a.trackingUrl.trim() }, ...readAndCapture()],
    }),
  },
  {
    id: 'wikipedia',
    title: 'উইকিপিডিয়া',
    description: 'একটা বিষয়ের উইকিপিডিয়া পেজ খুলে সারমর্ম পড়ে এনে দেয়।',
    site: 'wikipedia.org',
    params: [{ name: 'topic', label: 'বিষয়', required: true, example: 'Dhaka' }],
    build: (a) => ({
      goal: `উইকিপিডিয়া: ${a.topic}`,
      steps: [
        { action: 'goto', url: `https://en.wikipedia.org/wiki/Special:Search?search=${enc(a.topic)}&go=Go` },
        ...readAndCapture(),
      ],
    }),
  },
]

const RECIPE_BY_ID = new Map(RECIPE_LIST.map((r) => [r.id, r]))

export interface RecipeMeta {
  id: string
  title: string
  description: string
  site: string
  bestEffort: boolean
  params: RecipeParam[]
}

export function listRecipes(): RecipeMeta[] {
  return RECIPE_LIST.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    site: r.site,
    bestEffort: Boolean(r.bestEffort),
    params: r.params,
  }))
}

export function getRecipe(id: string): BrowserRecipe | undefined {
  return RECIPE_BY_ID.get(id)
}

export type RecipeBuildResult =
  | { ok: true; built: BuiltRecipe }
  | { ok: false; error: string }

/** Validate required params then expand the recipe into raw task input. */
export function buildRecipeTask(id: string, args: Record<string, unknown>): RecipeBuildResult {
  const recipe = RECIPE_BY_ID.get(id)
  if (!recipe) return { ok: false, error: `unknown recipe: ${id}` }

  const clean: Record<string, string> = {}
  for (const p of recipe.params) {
    const raw = args?.[p.name]
    const val = raw === undefined || raw === null ? '' : String(raw).trim()
    if (p.required && !val) {
      return { ok: false, error: `recipe "${id}" requires param "${p.name}" (${p.label})` }
    }
    clean[p.name] = val
  }

  try {
    const built = recipe.build(clean)
    return { ok: true, built }
  } catch (err) {
    return { ok: false, error: `recipe build failed: ${String(err)}` }
  }
}

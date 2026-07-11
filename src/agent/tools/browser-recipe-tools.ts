/**
 * Phase B (site recipes) — owner-facing tools to discover and run reusable
 * browser-task recipes.
 *
 *   • list_browser_recipes — show the available recipes (id, what they do, params).
 *   • run_browser_recipe   — pick a recipe + fill params; it expands into browser
 *                            steps and creates a PENDING ACTION (owner approval),
 *                            reusing the exact Phase A gating + approval pipeline.
 *
 * Recipes never bypass approval or the kill-switch — they are a convenience layer
 * on top of run_browser_task.
 */
import type { AgentTool } from './registry'
import {
  checkBrowserDailyCap,
  createBrowserTaskPendingAction,
  isBrowserAgentEnabled,
  normalizeBrowserTask,
} from '@/agent/lib/browser/actions'
import { buildRecipeTask, listRecipes } from '@/agent/lib/browser/recipes'
import {
  buildLearnedRecipeTask,
  listLearnedRecipes,
  saveLearnedRecipe,
} from '@/agent/lib/browser/learned-recipes'

const BROWSER_OFF_MESSAGE =
  'ব্রাউজার দিয়ে কাজ করার ক্ষমতা এখন বন্ধ আছে, Boss। চালু করতে বলুন — ' +
  '"ব্রাউজার এজেন্ট চালু করো" (settings: browser_agent_enabled = true)।'

const list_browser_recipes: AgentTool = {
  name: 'list_browser_recipes',
  description:
    'List the ready-made browser-task recipes (Phase B). Each recipe is a named, ' +
    'reusable template (e.g. web search, open a page, check a price, currency rate, ' +
    'track a parcel, wikipedia). Use this to discover what is available, then call ' +
    'run_browser_recipe with the recipe id and its params. Owner-facing, answer in Bangla.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      // P5: learned recipes (distilled from PROVEN successful runs) list beside
      // the built-in ones. Their ids start with "learned:".
      const learned = await listLearnedRecipes()
      return {
        success: true,
        data: {
          recipes: listRecipes(),
          learned: learned.map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description,
            site: r.site,
            uses: r.uses,
            learnedAt: r.learnedAt,
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const run_browser_recipe: AgentTool = {
  name: 'run_browser_recipe',
  description:
    'Run a ready-made browser recipe by id (see list_browser_recipes). Provide ' +
    '`recipeId` and an `args` object with the recipe params (e.g. {query} for web_search, ' +
    '{url} for open_page, {from,to} for currency_rate, {trackingUrl} for track_parcel). ' +
    'This ALWAYS creates a PENDING ACTION — the owner must approve before the browser runs. ' +
    'Prefer a recipe over hand-built steps when one fits. Owner-facing, confirm in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      recipeId: { type: 'string', description: 'Recipe id from list_browser_recipes' },
      args: {
        type: 'object',
        description: 'Recipe params as key→value (e.g. {"query":"..."} or {"url":"..."})',
      },
      conversationId: { type: 'string' },
    },
    required: ['recipeId'],
  },
  handler: async (input) => {
    try {
      if (!(await isBrowserAgentEnabled())) {
        return { success: false, error: 'browser_agent_disabled', data: { message: BROWSER_OFF_MESSAGE } }
      }

      const cap = await checkBrowserDailyCap()
      if (!cap.ok) {
        return {
          success: false,
          error: cap.error,
          data: { message: 'আজকের ব্রাউজার-টাস্কের সীমা পূর্ণ হয়ে গেছে, Boss — কাল আবার চেষ্টা করুন বা সীমা বাড়াতে বলুন।' },
        }
      }

      const recipeId = String(input.recipeId ?? '').trim()
      if (!recipeId) return { success: false, error: 'recipeId is required' }
      const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>

      // P5: "learned:" ids replay the proven steps of a learned recipe; both
      // paths funnel through the SAME normalize + owner-approval gate below.
      const built = recipeId.startsWith('learned:')
        ? await buildLearnedRecipeTask(recipeId)
        : buildRecipeTask(recipeId, args)
      if (!built.ok) return { success: false, error: built.error }

      // Funnel through the same validation the free-form tool uses.
      const normalized = normalizeBrowserTask({
        goal: built.built.goal,
        steps: built.built.steps,
        startUrl: built.built.startUrl,
        conversationId: input.conversationId,
      })
      if (!normalized.ok) return { success: false, error: normalized.error }

      const created = await createBrowserTaskPendingAction(normalized.payload)
      return {
        success: true,
        data: {
          ...created,
          recipeId,
          message:
            `"${recipeId}" রেসিপিটা তৈরি করলাম, Boss — আপনার অনুমতির পরই ব্রাউজারে চালাব।` +
            (created.critical ? ' ⚠️ এতে টাকা/অপরিবর্তনীয় কিছু থাকতে পারে, দেখে অনুমতি দিন।' : ''),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const save_learned_recipe: AgentTool = {
  name: 'save_learned_recipe',
  description:
    'P5 recipe learning: after a browser task COMPLETED SUCCESSFULLY (verified result — never save a ' +
    'guess or a failed run), distill it into a reusable recipe so the same job next time replays the ' +
    'PROVEN steps instead of re-deriving them. Pass the title (short Bangla), what it does, the site, ' +
    'the goal line, optional startUrl, and the EXACT steps that worked (the browser-task step list). ' +
    'Learned recipes appear in list_browser_recipes (ids start with "learned:") and run through ' +
    'run_browser_recipe with the SAME owner-approval gate as everything else. Saving the same title ' +
    'again refreshes the steps (re-proven run wins).',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short Bangla title, e.g. "দারাজে প্রাইস চেক"' },
      description: { type: 'string', description: 'What it does (owner-facing Bangla).' },
      site: { type: 'string', description: 'Target site/domain label, e.g. "daraz.com.bd".' },
      goal: { type: 'string', description: 'The task goal line used when replaying.' },
      startUrl: { type: 'string', description: 'Optional http(s) start URL.' },
      steps: {
        type: 'array',
        items: { type: 'object' },
        description: 'The exact browser-task steps that worked (max 30).',
      },
    },
    required: ['title', 'description', 'site', 'goal', 'steps'],
  },
  handler: async (input) => {
    try {
      const res = await saveLearnedRecipe({
        title: String(input.title ?? ''),
        description: String(input.description ?? ''),
        site: String(input.site ?? ''),
        goal: String(input.goal ?? ''),
        startUrl: input.startUrl ? String(input.startUrl) : undefined,
        steps: Array.isArray(input.steps) ? (input.steps as Array<Record<string, unknown>>) : [],
      })
      if (!res.ok) return { success: false, error: res.error }
      return {
        success: true,
        data: {
          id: res.id,
          message: `রেসিপিটা শিখে রাখলাম, Boss — পরেরবার একই কাজ প্রমাণিত ধাপেই চলবে (id: ${res.id})।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BROWSER_RECIPE_TOOLS: AgentTool[] = [
  list_browser_recipes,
  run_browser_recipe,
  save_learned_recipe,
]

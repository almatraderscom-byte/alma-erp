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

const BROWSER_OFF_MESSAGE =
  'ব্রাউজার দিয়ে কাজ করার ক্ষমতা এখন বন্ধ আছে, Sir। চালু করতে বলুন — ' +
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
      return { success: true, data: { recipes: listRecipes() } }
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
          data: { message: 'আজকের ব্রাউজার-টাস্কের সীমা পূর্ণ হয়ে গেছে, Sir — কাল আবার চেষ্টা করুন বা সীমা বাড়াতে বলুন।' },
        }
      }

      const recipeId = String(input.recipeId ?? '').trim()
      if (!recipeId) return { success: false, error: 'recipeId is required' }
      const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>

      const built = buildRecipeTask(recipeId, args)
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
            `"${recipeId}" রেসিপিটা তৈরি করলাম, Sir — আপনার অনুমতির পরই ব্রাউজারে চালাব।` +
            (created.critical ? ' ⚠️ এতে টাকা/অপরিবর্তনীয় কিছু থাকতে পারে, দেখে অনুমতি দিন।' : ''),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BROWSER_RECIPE_TOOLS: AgentTool[] = [list_browser_recipes, run_browser_recipe]

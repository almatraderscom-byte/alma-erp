/**
 * Phase A (browser-agent foundation) — owner-facing tools that let the agent
 * do real-browser tasks on the owner's behalf (instead of wiring up APIs).
 *
 *   • run_browser_task   — record a browser task as a pending action. ALWAYS
 *                          owner-approval gated; the separate VPS browser-service
 *                          (Playwright) executes it after approval.
 *   • check_browser_task — read the status/result of a recorded browser task.
 *
 * Guarded by the `browser_agent_enabled` KV kill-switch (default OFF) on top of
 * the global AGENT_ENABLED flag. No credential persistence in this phase.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import {
  BROWSER_ACTION_TYPE,
  checkBrowserDailyCap,
  createBrowserTaskPendingAction,
  isBrowserAgentEnabled,
  normalizeBrowserTask,
} from '@/agent/lib/browser/actions'
import { driverLabel } from '@/agent/lib/browser/drivers'

const run_browser_task: AgentTool = {
  name: 'run_browser_task',
  description:
    'Use a REAL web browser to do a task on the owner\'s behalf — when no API is available or APIs are too much hassle. ' +
    'Examples: open a site and read a price, fill a search box and extract results, check a tracking page, take a screenshot. ' +
    'This tool ALWAYS creates a PENDING ACTION — the owner must approve before anything runs in the browser. ' +
    'Provide a plain-language `goal` and an ordered list of `steps`. Step actions: ' +
    'goto {url}, click {selector|text}, type {selector, value}, press {key}, wait {selector|ms}, ' +
    'extract {selector?, what:text|html}, screenshot. The first step must navigate (goto) or set startUrl. ' +
    'Money / checkout / delete / transfer tasks are flagged CRITICAL and the owner is warned. ' +
    'Owner-facing, confirm in Bangla. If the capability is OFF, tell the owner how to turn it on.',
  input_schema: {
    type: 'object' as const,
    properties: {
      goal: { type: 'string', description: 'One-line plain-language goal of the task' },
      startUrl: { type: 'string', description: 'Optional first URL to open (http/https)' },
      steps: {
        type: 'array',
        description: 'Ordered browser steps to execute',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['goto', 'click', 'type', 'press', 'extract', 'screenshot', 'wait'],
            },
            url: { type: 'string' },
            selector: { type: 'string' },
            text: { type: 'string', description: 'Visible text to locate an element' },
            value: { type: 'string', description: 'Text to type (for type action)' },
            key: { type: 'string', description: 'Key to press, e.g. Enter' },
            ms: { type: 'number', description: 'Milliseconds to wait' },
            what: { type: 'string', enum: ['text', 'html'] },
          },
          required: ['action'],
        },
      },
      driver: {
        type: 'string',
        enum: ['vps', 'vps_live', 'companion'],
        description:
          'Which browser should run this. Omit for the default (vps). ' +
          'Use "vps_live" when the task may hit a login or captcha the agent cannot pass alone — the owner can watch and take over. ' +
          'Use "companion" to run in the owner\'s own logged-in Mac Chrome. ' +
          'Note: sites carrying the owner\'s business identity (Meta/Facebook, banks, mobile money, infra consoles) are ALWAYS forced to "companion" — asking for vps there is overridden.',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['goal'],
  },
  handler: async (input) => {
    try {
      if (!(await isBrowserAgentEnabled())) {
        return {
          success: false,
          error: 'browser_agent_disabled',
          data: {
            message:
              'ব্রাউজার দিয়ে কাজ করার ক্ষমতা এখন বন্ধ আছে, Boss। চালু করতে বলুন — ' +
              '"ব্রাউজার এজেন্ট চালু করো" (settings: browser_agent_enabled = true)।',
          },
        }
      }

      const cap = await checkBrowserDailyCap()
      if (!cap.ok) {
        return {
          success: false,
          error: cap.error,
          data: { message: 'আজকের ব্রাউজার-টাস্কের সীমা পূর্ণ হয়ে গেছে, Boss — কাল আবার চেষ্টা করুন বা সীমা বাড়াতে বলুন।' },
        }
      }

      const normalized = normalizeBrowserTask(input)
      if (!normalized.ok) {
        return { success: false, error: normalized.error }
      }
      // Shared create-path: it resolves the driver (owner-only hosts force the
      // owner's own Chrome), builds the summary and records the pending action.
      const created = await createBrowserTaskPendingAction(normalized.payload)

      return {
        success: true,
        data: {
          pendingActionId: created.pendingActionId,
          critical: created.critical,
          stepCount: created.stepCount,
          summary: created.summary,
          driver: created.driver,
          driverReason: created.driverReason,
          autoApproved: created.autoApproved,
          message: created.autoApproved
            ? `ব্রাউজার টাস্কটা ${driverLabel(created.driver)}-এ চালাতে পাঠালাম, Boss — ${created.consentReason}`
            : `ব্রাউজার টাস্কটা তৈরি করলাম, Boss — চলবে ${driverLabel(created.driver)}-এ, আপনার অনুমতির পরই।` +
              (created.critical ? ' ⚠️ এতে টাকা/অপরিবর্তনীয় কিছু থাকতে পারে, দেখে অনুমতি দিন।' : ''),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const check_browser_task: AgentTool = {
  name: 'check_browser_task',
  description:
    'Read the status/result of a browser task created by run_browser_task. ' +
    'Pass the `pendingActionId`. Reports whether it is pending / approved / executed / failed, ' +
    'and includes the extracted data or error once the browser-service has run it. ' +
    'Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: { type: 'string', description: 'Id returned by run_browser_task' },
    },
    required: ['pendingActionId'],
  },
  handler: async (input) => {
    try {
      const id = String(input.pendingActionId ?? '').trim()
      if (!id) return { success: false, error: 'pendingActionId is required' }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.findUnique({
        where: { id },
        select: { id: true, type: true, status: true, summary: true, result: true, createdAt: true, resolvedAt: true },
      })
      if (!action || action.type !== BROWSER_ACTION_TYPE) {
        return { success: false, error: `browser task ${id} not found` }
      }

      const statusLabel: Record<string, string> = {
        pending: 'অনুমতির অপেক্ষায়',
        approved: 'অনুমোদিত — চলছে/সারিতে',
        executed: 'সম্পন্ন হয়েছে',
        rejected: 'বাতিল করা হয়েছে',
        failed: 'ব্যর্থ হয়েছে',
      }

      return {
        success: true,
        data: {
          id: action.id,
          status: action.status,
          statusLabel: statusLabel[action.status] ?? action.status,
          result: action.result ?? null,
          summary: action.summary,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

/**
 * The "don't ask me again for this job" grant. Only ever called when the OWNER
 * says so — never inferred from the agent's own convenience, and never used to
 * pre-empt a card the owner has not seen.
 */
const allow_browser_for_this_chat: AgentTool = {
  name: 'allow_browser_for_this_chat',
  description:
    'Record the owner\'s permission to run further browser tasks in THIS conversation without asking each time. ' +
    'Call this ONLY when the owner explicitly says so ("do not ask again", "just do it", "আর জিজ্ঞেস কোরো না"). ' +
    'The grant expires on its own and covers a limited number of tasks. It never covers money/checkout/delete tasks, ' +
    'never covers the owner\'s own Chrome, and never covers his logged-in business sites — those always ask. ' +
    'Pass action="revoke" to cancel a grant. Owner-facing, confirm in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['grant', 'revoke'], description: 'grant (default) or revoke' },
      driver: {
        type: 'string',
        enum: ['vps', 'vps_live'],
        description: 'Which browser the grant covers. Defaults to vps. A grant for one does not cover the other.',
      },
      conversationId: { type: 'string', description: 'Server-managed — omit; the server fills it automatically.' },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const conversationId = String(input.conversationId ?? '').trim()
      if (!conversationId) {
        return { success: false, error: 'no conversation in context' }
      }
      const { grantBrowserConsent, revokeBrowserConsent } = await import('@/agent/lib/browser/consent')

      if (String(input.action ?? 'grant') === 'revoke') {
        await revokeBrowserConsent(conversationId)
        return {
          success: true,
          data: { message: 'ঠিক আছে Boss — এখন থেকে প্রতিটা ব্রাউজার কাজের আগে আবার জিজ্ঞেস করব।' },
        }
      }

      const driver = input.driver === 'vps_live' ? 'vps_live' : 'vps'
      const granted = await grantBrowserConsent(conversationId, driver)
      if (!granted.ok || !granted.entry) {
        return { success: false, error: granted.error ?? 'could not record consent' }
      }
      const until = new Date(granted.entry.expiresAt).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Dhaka',
        hour: '2-digit',
        minute: '2-digit',
      })
      return {
        success: true,
        data: {
          expiresAt: granted.entry.expiresAt,
          remaining: granted.entry.remaining,
          message:
            `বুঝেছি Boss — এই আলাপে ${driverLabel(granted.entry.driver)}-এর কাজ আর জিজ্ঞেস করব না ` +
            `(${granted.entry.remaining}টি কাজ পর্যন্ত, ${until} পর্যন্ত)। ` +
            'টাকা/অপরিবর্তনীয় কাজ আর আপনার লগইন করা সাইট তবু জিজ্ঞেস করব।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BROWSER_TOOLS: AgentTool[] = [run_browser_task, check_browser_task, allow_browser_for_this_chat]

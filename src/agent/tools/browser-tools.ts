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
  isBrowserAgentEnabled,
  isCriticalBrowserTask,
  normalizeBrowserTask,
  summarizeBrowserTask,
} from '@/agent/lib/browser/actions'

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
      conversationId: { type: 'string' },
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
      const payload = normalized.payload
      const summary = summarizeBrowserTask(payload)
      const critical = isCriticalBrowserTask(payload)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId: payload.conversationId,
          type: BROWSER_ACTION_TYPE,
          payload: { ...payload, critical },
          summary,
          costEstimate: null,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          critical,
          stepCount: payload.steps.length,
          summary,
          message:
            'ব্রাউজার টাস্কটা তৈরি করলাম, Boss — আপনার অনুমতির পরই ব্রাউজারে চালাব।' +
            (critical ? ' ⚠️ এতে টাকা/অপরিবর্তনীয় কিছু থাকতে পারে, দেখে অনুমতি দিন।' : ''),
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

export const BROWSER_TOOLS: AgentTool[] = [run_browser_task, check_browser_task]

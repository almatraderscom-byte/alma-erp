/**
 * Phase 6 — Agent KV settings tools + salah override tools.
 * SINGLE SOURCE OF TRUTH: every owner command that changes behavior is written to DB here.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// ── update_setting ────────────────────────────────────────────────────────────

const update_setting: AgentTool = {
  name: 'update_setting',
  description:
    'Writes a key-value setting to the database. ' +
    'Use when the owner changes behavior (escalation level, grief context, scheduler times, etc.). ' +
    'Requires a confirm card — always call this, never keep owner instructions only in chat context.',
  input_schema: {
    type: 'object' as const,
    properties: {
      key:            { type: 'string', description: 'Setting key (e.g. salah_escalation_level)' },
      value:          { type: 'string', description: 'New value' },
      conversationId: { type: 'string' },
    },
    required: ['key', 'value'],
  },
  handler: async (input) => {
    try {
      const key   = String(input.key).trim()
      const value = String(input.value).trim()

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:     'update_setting',
          payload:  { key, value },
          summary:  `সেটিং আপডেট: ${key} = "${value}"`,
          costEstimate: 0,
          status:   'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary: action.summary,
          message: 'Pending owner approval before saving.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── get_settings ──────────────────────────────────────────────────────────────

const get_settings: AgentTool = {
  name: 'get_settings',
  description:
    'Returns current agent key-value settings. ' +
    'Check this before quoting any behavioral setting to the owner.',
  input_schema: {
    type: 'object' as const,
    properties: {
      keys: { type: 'string', description: 'Comma-separated keys to fetch (omit for all)' },
    },
  },
  handler: async (input) => {
    try {
      const keyFilter = input.keys
        ? String(input.keys).split(',').map(k => k.trim()).filter(Boolean)
        : null

      const rows = await db.agentKvSetting.findMany({
        where: keyFilter ? { key: { in: keyFilter } } : undefined,
        orderBy: { key: 'asc' },
      })

      const result: Record<string, string> = {}
      for (const r of rows) result[r.key] = r.value

      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── set_salah_override ────────────────────────────────────────────────────────

const set_salah_override: AgentTool = {
  name: 'set_salah_override',
  description:
    'Overrides the reminder time for a specific salah waqt. ' +
    'Use when the owner says "আজ Dhuhr ২:৩০-এ পড়বো" or "Asr skip করব (সফরে আছি)". ' +
    'Creates a PENDING ACTION — owner must confirm before the override takes effect.',
  input_schema: {
    type: 'object' as const,
    properties: {
      waqt:           { type: 'string', enum: ['fajr','dhuhr','asr','maghrib','isha'], description: 'Which prayer' },
      date:           { type: 'string', description: 'YYYY-MM-DD (default: today)' },
      overrideTime:   { type: 'string', description: 'ISO datetime: send reminder at this time instead (mutually exclusive with delayUntil/skip)' },
      delayUntil:     { type: 'string', description: 'ISO datetime: delay reminders until this time' },
      skip:           { type: 'boolean', description: 'true = skip reminders entirely (e.g. travel, illness)' },
      reason:         { type: 'string', description: 'Reason for override (stored for audit)' },
      conversationId: { type: 'string' },
    },
    required: ['waqt'],
  },
  handler: async (input) => {
    try {
      const waqt   = String(input.waqt)
      const date   = (input.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
      const skip   = input.skip === true
      const reason = input.reason ? String(input.reason) : null

      let description = `${waqt} ওভাররাইড (${date})`
      if (skip) description += ' — skip'
      else if (input.delayUntil) description += ` — delay until ${input.delayUntil}`
      else if (input.overrideTime) description += ` — remind at ${input.overrideTime}`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type:    'salah_override',
          payload: {
            waqt, date, skip,
            overrideTime: input.overrideTime ?? null,
            delayUntil:   input.delayUntil ?? null,
            reason,
          },
          summary:      description,
          costEstimate: 0,
          status:       'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary: description,
          message: 'Salah override pending your confirmation.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const SETTINGS_TOOLS: AgentTool[] = [
  update_setting,
  get_settings,
  set_salah_override,
]

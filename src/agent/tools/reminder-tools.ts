/**
 * Phase 9 — Personal reminders + urgent alerts.
 */
import { prisma } from '@/lib/prisma'
import { formatReminderConfirmation } from '@/agent/lib/reminder-rrule'
import { checkUrgentRateLimit, checkOutboundCallRateLimit } from '@/agent/lib/urgent-rate-limit'
import { summarizeOutboundAction, isBlockingOutboundDuplicate } from '@/agent/lib/outbound-call-tracking'
import { normalizeOutboundPhone } from '@/lib/twilio/phone'
import { voicePrefLabel, type OwnerVoicePref } from '@/agent/lib/voice-provider-intent'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const APP_URL = () => (process.env.APP_URL ?? '').replace(/\/$/, '')
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function dispatchUrgentNow(payload: { tier: number; title: string; message: string; voice?: boolean }) {
  const base = APP_URL()
  if (!base || !INT_TOKEN()) {
    return { ok: false, error: 'APP_URL or AGENT_INTERNAL_TOKEN not configured' }
  }
  const res = await fetch(`${base}/api/assistant/internal/urgent-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` }
  return { ok: true, data }
}

const set_reminder: AgentTool = {
  name: 'set_reminder',
  description:
    'Sets a personal reminder at a future time (Asia/Dhaka). Resolve natural language to ISO dueAt before calling. ' +
    'tier 1=normal, 2=critical ntfy, 3=phone call. tier 3 requires owner confirm card. Never claim reminder is set without this tool.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short reminder title (Bangla)' },
      body: { type: 'string', description: 'Optional longer detail spoken/shown with the reminder' },
      dueAt: { type: 'string', description: 'ISO 8601 datetime (future)' },
      recurrenceRrule: { type: 'string', description: 'e.g. FREQ=DAILY' },
      tier: { type: 'number', description: '1, 2, or 3 (default 1)' },
      voice: { type: 'boolean', description: 'true → also speak it as Bangla TTS voice' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['title', 'dueAt'],
  },
  handler: async (input) => {
    try {
      const title = String(input.title).trim()
      const dueAt = new Date(String(input.dueAt))
      if (!title || Number.isNaN(dueAt.getTime())) {
        return { success: false, error: 'title and valid dueAt required' }
      }
      if (dueAt.getTime() <= Date.now()) {
        return { success: false, error: 'dueAt must be in the future' }
      }

      const tier = Math.min(3, Math.max(1, Number(input.tier ?? 1)))
      const voice = input.voice !== false

      if (tier === 3) {
        const action = await db.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'set_reminder_tier3',
            payload: {
              title,
              body: input.body ? String(input.body) : null,
              dueAt: dueAt.toISOString(),
              recurrenceRrule: input.recurrenceRrule ? String(input.recurrenceRrule) : null,
              tier,
              voice,
            },
            summary: `📞 Tier-3 রিমাইন্ডার (কল): ${title}\nসময়: ${dueAt.toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' })}`,
            costEstimate: 0.05,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: {
            pendingActionId: action.id,
            message: 'Tier-3 reminder needs Approve (phone call at due time).',
          },
        }
      }

      const reminder = await db.agentReminder.create({
        data: {
          title,
          body: input.body ? String(input.body) : null,
          dueAt,
          recurrenceRrule: input.recurrenceRrule ? String(input.recurrenceRrule) : null,
          tier,
          voice,
          status: 'pending',
          sourceConversationId: input.conversationId ? String(input.conversationId) : null,
        },
      })

      return {
        success: true,
        data: {
          id: reminder.id,
          confirmation: formatReminderConfirmation(title, dueAt),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const list_reminders: AgentTool = {
  name: 'list_reminders',
  description: 'Lists personal reminders, optionally filtered by status.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'pending,sent,snoozed,done,cancelled (comma-separated)' },
    },
  },
  handler: async (input) => {
    try {
      const where: Record<string, unknown> = {}
      if (input.status) {
        where.status = { in: String(input.status).split(',').map((s) => s.trim()) }
      } else {
        where.status = { in: ['pending', 'sent', 'snoozed'] }
      }
      const rows = await db.agentReminder.findMany({
        where,
        orderBy: { dueAt: 'asc' },
        take: 30,
      })
      return { success: true, data: rows }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const cancel_reminder: AgentTool = {
  name: 'cancel_reminder',
  description: 'Cancels a reminder by id.',
  input_schema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'Reminder id from list_reminders' } },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const updated = await db.agentReminder.update({
        where: { id: String(input.id) },
        data: { status: 'cancelled' },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const snooze_reminder: AgentTool = {
  name: 'snooze_reminder',
  description: 'Snoozes a reminder for N minutes.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'Reminder id from list_reminders' },
      minutes: { type: 'number', description: 'Default 30' },
    },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const minutes = Math.max(1, Number(input.minutes ?? 30))
      const snoozedUntil = new Date(Date.now() + minutes * 60_000)
      const updated = await db.agentReminder.update({
        where: { id: String(input.id) },
        data: { status: 'snoozed', snoozedUntil },
      })
      return { success: true, data: updated }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const send_urgent_alert: AgentTool = {
  name: 'send_urgent_alert',
  description:
    'Sends an immediate urgent alert via notify (ntfy + Telegram + optional voice/call). ' +
    'tier 2=critical ntfy (5/hour limit). tier 3=phone call — requires confirm card (5/24h limit, salah excluded). ' +
    'Use when Boss says urgent/জরুরি or explicitly asks for a call.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short alert title (Bangla)' },
      message: { type: 'string', description: 'The alert body the owner will read/hear' },
      tier: { type: 'number', enum: [2, 3], description: '2=critical ntfy push, 3=phone call (confirm card required)' },
      voice: { type: 'boolean', description: 'true → also speak it as Bangla TTS voice' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['title', 'message', 'tier'],
  },
  handler: async (input) => {
    try {
      const tier = Number(input.tier) === 3 ? 3 : 2
      const title = String(input.title).trim()
      const message = String(input.message).trim()
      if (!title || !message) return { success: false, error: 'title and message required' }

      const rate = await checkUrgentRateLimit(tier as 2 | 3)
      if (!rate.ok) return { success: false, error: rate.error }

      const voice = input.voice !== false

      if (tier === 3) {
        const action = await db.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'urgent_notify',
            payload: { tier, title, message, voice },
            summary: `🚨 জরুরি কল: ${title}\n\n${message.slice(0, 200)}`,
            costEstimate: 0.05,
            status: 'pending',
          },
        })
        return {
          success: true,
          data: { pendingActionId: action.id, message: 'Tier-3 urgent alert needs Approve before call.' },
        }
      }

      const dispatched = await dispatchUrgentNow({ tier, title, message, voice })
      if (!dispatched.ok) return { success: false, error: dispatched.error }

      return {
        success: true,
        data: { tier, title, message: 'Critical alert dispatched (ntfy + Telegram).' },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_outbound_call_status: AgentTool = {
  name: 'get_outbound_call_status',
  description:
    'Returns status of recent outbound phone calls (pending, dialed, answered, no-answer). ' +
    'Searches across ALL conversations — not limited to the current one. ' +
    'Use when Boss asks whether a call was placed, answered, or what happened — do NOT create a new outbound_phone_call.',
  input_schema: {
    type: 'object' as const,
    properties: {
      phone: { type: 'string', description: 'Filter by number (01… or +880…). Recommended.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
  },
  handler: async (input) => {
    try {
      const phoneFilter = input.phone ? normalizeOutboundPhone(String(input.phone)) : null

      const where: Record<string, unknown> = {
        type: 'outbound_call',
        createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      }

      const rows = await db.agentPendingAction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 20,
      })

      const filtered = phoneFilter
        ? rows.filter((r: { payload: { phone?: string } }) =>
            normalizeOutboundPhone(String(r.payload?.phone ?? '')) === phoneFilter)
        : rows

      return {
        success: true,
        data: {
          calls: filtered.map(summarizeOutboundAction),
          hint: 'phase: awaiting_approve | approved_queued | dialed | answered | no_answer_retry_offered | failed',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const outbound_phone_call: AgentTool = {
  name: 'outbound_phone_call',
  description:
    'ONE-WAY voice call: dials a number, speaks a fixed Bangla TTS message, then hangs up. ' +
    'The agent does NOT listen and gets NO reply back — it cannot answer questions or report ' +
    'what the other person said. Use ONLY when Boss just wants a message DELIVERED/announced and ' +
    'expects nothing back (e.g. "017… কে কল করে জানিয়ে দাও/বলে দাও …"). ' +
    'If Boss wants the agent to ASK something, LISTEN, hold a conversation, or report back what ' +
    'the person said, DO NOT use this — use place_agent_call (two-way) instead. ' +
    'Always requires Approve confirm card before dialing. Owner-only; Bangladesh +880 numbers.',
  input_schema: {
    type: 'object' as const,
    properties: {
      phone: { type: 'string', description: 'Phone number (01XXXXXXXXX or +880…)' },
      message: { type: 'string', description: 'Exact message to speak on the call' },
      ttsProvider: {
        type: 'string',
        enum: ['google', 'elevenlabs'],
        description: 'google = default. elevenlabs when Boss asks for ElevenLabs voice on the call.',
      },
      voiceGender: {
        type: 'string',
        enum: ['male', 'female'],
        description: 'Only when ttsProvider=elevenlabs. male=Charlie, female=River. Default male.',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['phone', 'message'],
  },
  handler: async (input) => {
    try {
      const phone = normalizeOutboundPhone(String(input.phone ?? ''))
      const message = String(input.message ?? '').trim()
      if (!phone) return { success: false, error: 'Invalid phone number. Use 01XXXXXXXXX or +880…' }
      if (!message) return { success: false, error: 'message required' }
      if (!phone.startsWith('+880')) {
        return { success: false, error: 'Only Bangladesh numbers (+880) are supported for outbound calls.' }
      }

      const rate = await checkOutboundCallRateLimit()
      if (!rate.ok) return { success: false, error: rate.error }

      // VOICE = Boss's words, not the model's guess. `ownerVoicePref` arrives via the
      // tool's SERVER context (which wins over model args), resolved by regex from his
      // recent messages. Prod audit found the model picked ElevenLabs 11 of 12 times
      // — ~18× Google's cost — despite "google = default" in this tool's description.
      // Only Boss naming ElevenLabs buys the expensive voice. No context (scheduler /
      // heartbeat path) → keep the model's value, which already defaults to google.
      const pref = input.ownerVoicePref as OwnerVoicePref | undefined
      const ttsProvider: 'google' | 'elevenlabs' = pref
        ? pref.provider
        : input.ttsProvider === 'elevenlabs' ? 'elevenlabs' : 'google'
      const voiceGender: 'male' | 'female' = pref
        ? pref.gender
        : input.voiceGender === 'female' ? 'female' : 'male'
      const voiceLine = pref
        ? voicePrefLabel(pref)
        : ttsProvider === 'elevenlabs' ? 'ElevenLabs' : 'Google'
      const cardSummary = (msg: string) =>
        `📞 কল → ${phone}\n🔊 ভয়েস: ${voiceLine}\n\n🗣️ "${msg.slice(0, 300)}"`

      {
        const recent = await db.agentPendingAction.findMany({
          where: {
            type: 'outbound_call',
            createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
        // A DIALED call is not a DELIVERED one — see isBlockingOutboundDuplicate.
        // The old rule blocked every new call to a number dialed in the last 2 hours,
        // so after a call rang unanswered, Boss asking "abar call koro" was silently
        // swallowed while the agent reported success (live 2026-07-18).
        const nowMs = Date.now()
        const duplicate = recent.find((r: { payload: { phone?: string } }) => {
          if (normalizeOutboundPhone(String(r.payload?.phone ?? '')) !== phone) return false
          return isBlockingOutboundDuplicate(r as unknown as Parameters<typeof isBlockingOutboundDuplicate>[0], nowMs)
        })
        if (duplicate) {
          // A still-PENDING card is an editable draft (not yet dialing). The old code
          // refused outright here, which stranded every redraft AND suppressed the voice
          // preview (the preview only fires when a card surfaces this turn). Instead,
          // update the draft in place with the latest wording/voice and re-surface it:
          // returning pendingActionId makes core.ts emit a fresh confirm_card, which the
          // delivery layer turns into a NEW voice preview — so Boss always hears the
          // CURRENT message. No reject-then-recreate dance, no "duplicate" dead-ends.
          if (duplicate.status === 'pending') {
            const updated = await db.agentPendingAction.update({
              where: { id: duplicate.id },
              data: {
                payload: { phone, message, ttsProvider, voiceGender },
                summary: cardSummary(message),
              },
            })
            return {
              success: true,
              data: {
                pendingActionId: updated.id,
                phone,
                updatedExisting: true,
                message:
                  'Existing draft updated with the new wording — confirm card refreshed and the voice preview re-sent. Boss must Approve before dialing.',
              },
            }
          }
          // Reaches here only for: approved-and-queued, currently-ringing (<90s), or
          // already-answered. A no-answer/failed row is NOT a duplicate (handled above)
          // so "abar call koro" after an unanswered call falls through and places a
          // real new call. Tell the model the EXACT phase so it never claims a call was
          // just placed when it wasn't.
          const summary = summarizeOutboundAction(duplicate)
          const inFlightNote =
            summary.phase === 'answered'
              ? 'This number was already CALLED and the person ANSWERED — the message was delivered. Do NOT say you are placing a new call; report that it was already delivered. Only place another call if Boss explicitly wants to call again.'
              : summary.status === 'approved'
                ? 'A call to this number is APPROVED and about to be dialed by the worker — it has NOT connected yet. Do NOT claim the call is done; say it is being placed now.'
                : 'A call to this number is RINGING right now (placed seconds ago). Do NOT place another or claim it finished; say it is ringing.'
          return {
            success: true,
            data: {
              duplicatePrevented: true,
              existingActionId: summary.pendingActionId,
              phone: summary.phone,
              status: summary.status,
              phase: summary.phase,
              dialed: summary.dialed,
              answered: summary.answered,
              callPlacedThisTurn: false,
              message: inFlightNote,
            },
          }
        }
      }

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'outbound_call',
          payload: { phone, message, ttsProvider, voiceGender },
          summary: cardSummary(message),
          costEstimate: 0.05,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: {
          pendingActionId: action.id,
          phone,
          voice: voiceLine,
          message:
            `Outbound call queued in the ${ttsProvider} voice — Boss must Approve before dialing. ` +
            'The voice was resolved from Boss\'s own words; do NOT claim a different voice than the one above.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const preview_call_voice: AgentTool = {
  name: 'preview_call_voice',
  description:
    'Re-sends the VOICE PREVIEW (spoken audio) of a pending outbound-call draft so Boss can HEAR the exact words before approving. ' +
    'Use whenever Boss asks to hear/replay the call message ("voice শোনাও / draft শুনি / আগে শোনাও / let me hear it"). ' +
    'You DO have this capability — never tell Boss you cannot play or preview the call audio. ' +
    'Defaults to the most recent pending draft; pass phone or pendingActionId to target a specific one.',
  input_schema: {
    type: 'object' as const,
    properties: {
      pendingActionId: { type: 'string', description: 'Specific draft to preview. Optional — defaults to the latest pending draft.' },
      phone: { type: 'string', description: 'Target the latest pending draft for this number. Optional.' },
    },
  },
  handler: async (input) => {
    try {
      const phoneFilter = input.phone ? normalizeOutboundPhone(String(input.phone)) : null
      let row: { id: string; type?: string; status?: string; payload?: { phone?: string } } | null = null

      if (input.pendingActionId) {
        row = await db.agentPendingAction.findUnique({ where: { id: String(input.pendingActionId) } })
        if (row && (row.type !== 'outbound_call' || row.status !== 'pending')) row = null
      }
      if (!row) {
        const rows = await db.agentPendingAction.findMany({
          where: {
            type: 'outbound_call',
            status: 'pending',
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
        const filtered = phoneFilter
          ? rows.filter((r: { payload: { phone?: string } }) =>
              normalizeOutboundPhone(String(r.payload?.phone ?? '')) === phoneFilter)
          : rows
        row = filtered[0] ?? null
      }

      if (!row) {
        return {
          success: true,
          data: {
            noPendingDraft: true,
            message: 'No pending call draft to preview — create one with outbound_phone_call first (it auto-sends the voice).',
          },
        }
      }

      // Returning pendingActionId makes core.ts emit a confirm_card for this still-pending
      // draft; the delivery layer turns that into a fresh voice preview Boss can hear.
      return {
        success: true,
        data: {
          pendingActionId: row.id,
          phone: String(row.payload?.phone ?? ''),
          previewResent: true,
          message: 'Voice preview re-sent — Boss can hear the draft now; ask him to Approve when satisfied.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const REMINDER_TOOLS: AgentTool[] = [
  set_reminder,
  list_reminders,
  cancel_reminder,
  snooze_reminder,
  send_urgent_alert,
  get_outbound_call_status,
  preview_call_voice,
  outbound_phone_call,
]

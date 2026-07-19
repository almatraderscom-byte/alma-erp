import { prisma } from '@/lib/prisma'
import { normalizeOutboundPhone } from '@/lib/twilio/phone'
import { checkOutboundCallRateLimit } from '@/agent/lib/urgent-rate-limit'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const add_family_contact: AgentTool = {
  name: 'add_family_contact',
  description:
    'Save a family member contact (name, relation, phone, optional notes). Use when the owner shares a family member\'s details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Family member name' },
      relation: { type: 'string', description: 'মা/স্ত্রী/বাবা/ভাই etc.' },
      phone: { type: 'string', description: 'Phone number in international format (+8801…)' },
      notes: { type: 'string', description: 'Optional free-text note' },
    },
    required: ['name', 'relation', 'phone'],
  },
  handler: async (input) => {
    try {
      const name = String(input.name ?? '').trim()
      const relation = String(input.relation ?? '').trim()
      const phone = String(input.phone ?? '').trim()
      if (!name || !relation || !phone) {
        return { success: false, error: 'name, relation, and phone are required' }
      }
      const c = await db.familyContact.create({
        data: { name, relation, phone, notes: input.notes ? String(input.notes) : null },
      })
      return {
        success: true,
        data: { status: 'saved', id: c.id, message: `${relation} (${name}) সেভ হয়েছে।` },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const list_family_contacts: AgentTool = {
  name: 'list_family_contacts',
  description:
    'List saved family contacts. Use to resolve "আম্মু", "স্ত্রী" etc. to a phone number, or when owner asks who is saved.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const rows = await db.familyContact.findMany({
        select: { id: true, name: true, relation: true, phone: true, notes: true },
        orderBy: { createdAt: 'asc' },
      })
      return { success: true, data: { count: rows.length, contacts: rows } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const call_family_member: AgentTool = {
  name: 'call_family_member',
  description:
    'Place a voice call to a family member and speak a message (TTS) on the owner\'s behalf. ' +
    'Use for "আম্মুকে কল দাও আর বলো…". Resolve the relation/name to a saved contact first. ' +
    'Creates a confirm card — owner approves before the call is placed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      relationOrName: { type: 'string', description: 'e.g. "মা", "স্ত্রী", or a name' },
      message: { type: 'string', description: 'What to say (Bangla). Will be spoken via TTS.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['relationOrName', 'message'],
  },
  handler: async (input) => {
    try {
      const needle = String(input.relationOrName ?? '').trim()
      const rawMessage = String(input.message ?? '').trim()
      if (!needle || !rawMessage) {
        return { success: false, error: 'relationOrName and message are required' }
      }

      const contacts = await db.familyContact.findMany({
        select: { id: true, name: true, relation: true, phone: true },
      })
      const contact = contacts.find(
        (c: { name: string; relation: string }) =>
          c.relation.includes(needle) ||
          c.name.includes(needle) ||
          needle.includes(c.relation) ||
          needle.includes(c.name),
      )
      if (!contact) {
        return {
          success: true,
          data: { status: 'not_found', message: `"${needle}" নামে কোনো contact সেভ নেই। আগে add করুন।` },
        }
      }

      const phone = normalizeOutboundPhone(contact.phone)
      if (!phone?.startsWith('+880')) {
        return { success: false, error: 'Invalid family contact phone. Use 01XXXXXXXXX or +880…' }
      }

      const rate = await checkOutboundCallRateLimit()
      if (!rate.ok) return { success: false, error: rate.error }

      const spoken = `আসসালামু আলাইকুম। ${contact.name} এর জন্য একটি বার্তা: ${rawMessage}`
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'outbound_call',
          payload: { phone, message: spoken, recipientName: contact.name },
          summary: `📞 ${contact.relation} (${contact.name}) কে কল — "${rawMessage.slice(0, 50)}"`,
          costEstimate: 0.05,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: {
          status: 'confirm_required',
          pendingActionId: action.id,
          message: `${contact.relation} কে কল করার জন্য confirm করুন।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const place_agent_call: AgentTool = {
  name: 'place_agent_call',
  description:
    'Place a REAL two-way Bangla phone call where the agent itself talks AND listens — this is ' +
    'the DEFAULT call tool whenever a back-and-forth is needed. Unlike outbound_phone_call ' +
    '(one-way TTS that only delivers a message and hangs up), this holds a LIVE conversation: ' +
    'the agent speaks in the owner\'s Bangla voice, hears the other person\'s replies, and after ' +
    'the call reports back a transcript + summary. ALWAYS use this (never the one-way tool) when ' +
    'the owner wants the agent to ASK/FIND OUT/CONFIRM something or report what was said — ' +
    '"কাউকে কল দিয়ে জিজ্ঞেস করো / কথা বলো / জেনে নাও / কনফার্ম করো" — family, friends, or work. ' +
    'Resolve a saved contact when a name/relation is given, else accept a raw number. ' +
    'Creates a confirm card — owner approves before it dials. Cost is high; use sparingly.',
  input_schema: {
    type: 'object' as const,
    properties: {
      relationOrName: { type: 'string', description: 'Saved contact name/relation (e.g. "মা", "ভাই"). Optional if phone given.' },
      phone: { type: 'string', description: 'Raw number (01XXXXXXXXX or +880…). Optional if relationOrName resolves.' },
      purpose: { type: 'string', description: 'Why we are calling, in Bangla — steers the conversation (e.g. "কালকের ডেলিভারি কনফার্ম করো").' },
      firstMessage: { type: 'string', description: 'First Bangla line the agent speaks when picked up. Optional — sensible default used.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['purpose'],
  },
  handler: async (input) => {
    try {
      const needle = String(input.relationOrName ?? '').trim()
      const rawPhone = String(input.phone ?? '').trim()
      const purpose = String(input.purpose ?? '').trim()
      if (!purpose) return { success: false, error: 'purpose is required' }
      if (!needle && !rawPhone) return { success: false, error: 'relationOrName বা phone — একটা লাগবে' }

      let recipientName: string | undefined
      let phone: string | null = null

      if (needle) {
        const contacts = await db.familyContact.findMany({
          select: { id: true, name: true, relation: true, phone: true },
        })
        const contact = contacts.find(
          (c: { name: string; relation: string }) =>
            c.relation.includes(needle) ||
            c.name.includes(needle) ||
            needle.includes(c.relation) ||
            needle.includes(c.name),
        )
        if (contact) {
          recipientName = contact.name
          phone = normalizeOutboundPhone(contact.phone)
        } else if (!rawPhone) {
          return {
            success: true,
            data: { status: 'not_found', message: `"${needle}" নামে contact সেভ নেই। নাম্বার দিন বা আগে add করুন।` },
          }
        }
      }
      if (!phone && rawPhone) phone = normalizeOutboundPhone(rawPhone)
      if (!phone) return { success: false, error: 'নম্বরটি ঠিক নয় — 01XXXXXXXXX বা +880… দিন।' }

      const firstMessage = String(input.firstMessage ?? '').trim() || 'আসসালামু আলাইকুম, কেমন আছেন?'
      // Voice = Boss's words (male → ashutosh/v3, female → anushka/v2). Resolved from his
      // recent messages via the server-injected ownerVoicePref; silence → female default.
      const pref = input.ownerVoicePref as { gender?: 'male' | 'female' } | undefined
      const voiceGender: 'male' | 'female' = pref?.gender === 'male' ? 'male' : 'female'
      const who = recipientName ?? phone
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'agent_voice_call',
          payload: { phone, toNumber: phone, recipientName, purpose, firstMessage, voiceGender, callType: 'contact' },
          summary: `📞 ${who} কে লাইভ কল — "${purpose.slice(0, 60)}"`,
          costEstimate: 0.5,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: {
          status: 'confirm_required',
          pendingActionId: action.id,
          message: `${who} কে লাইভ কল করার জন্য confirm করুন। কথা শেষ হলে সারাংশ পাবেন।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const schedule_call: AgentTool = {
  name: 'schedule_call',
  description:
    'Schedules a LIVE two-way phone call for a FUTURE time (Asia/Dhaka). Use when the owner says "কাল সকালে / বিকেল ৫টায় / ২ ঘন্টা পরে X কে কল দাও"। Resolve the natural-language time to an ISO dueAt first. Resolves a saved family contact OR an ALMA staff member by name, else a raw number. Creates a confirm card — the owner approves the schedule once, then the call fires automatically at the due time and a summary comes back. For calling right now, use call_family_member / call_staff instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      relationOrName: { type: 'string', description: 'Saved family contact (মা/ভাই) or ALMA staff name. Optional if phone given.' },
      phone: { type: 'string', description: 'Raw number (01XXXXXXXXX / +880…). Optional if relationOrName resolves.' },
      purpose: { type: 'string', description: 'Why we are calling, in Bangla — steers the call.' },
      dueAt: { type: 'string', description: 'ISO 8601 date-time (Asia/Dhaka resolved) when the call should be placed.' },
      firstMessage: { type: 'string', description: 'Optional first Bangla line the agent speaks.' },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: ['purpose', 'dueAt'],
  },
  handler: async (input) => {
    try {
      const needle = String(input.relationOrName ?? '').trim()
      const rawPhone = String(input.phone ?? '').trim()
      const purpose = String(input.purpose ?? '').trim()
      const dueAtRaw = String(input.dueAt ?? '').trim()
      if (!purpose) return { success: false, error: 'purpose লাগবে' }
      if (!needle && !rawPhone) return { success: false, error: 'relationOrName বা phone — একটা লাগবে' }
      const dueAt = new Date(dueAtRaw)
      if (!dueAtRaw || Number.isNaN(dueAt.getTime())) return { success: false, error: 'dueAt ঠিক নয় — ISO date-time দিন' }
      if (dueAt.getTime() < Date.now() - 60_000) return { success: false, error: 'সময়টা অতীতে — ভবিষ্যতের সময় দিন' }

      let recipientName: string | undefined
      let phone: string | null = null
      let callType: 'staff' | 'contact' = 'contact'

      if (needle) {
        const contacts = await db.familyContact.findMany({ select: { name: true, relation: true, phone: true } })
        const contact = contacts.find(
          (c: { name: string; relation: string }) =>
            c.relation.includes(needle) || c.name.includes(needle) || needle.includes(c.relation) || needle.includes(c.name),
        )
        if (contact) {
          recipientName = contact.name
          phone = normalizeOutboundPhone(contact.phone)
        } else {
          // Try ALMA staff (phone lives on the linked ERP user).
          const staff = await db.agentStaff.findFirst({
            where: { name: { contains: needle, mode: 'insensitive' }, active: true },
            select: { name: true, user: { select: { phone: true } } },
          })
          if (staff?.user?.phone) {
            recipientName = staff.name
            phone = normalizeOutboundPhone(staff.user.phone)
            callType = 'staff'
          } else if (!rawPhone) {
            return { success: true, data: { status: 'not_found', message: `"${needle}" নামে contact বা স্টাফ পাওয়া যায়নি।` } }
          }
        }
      }
      if (!phone && rawPhone) phone = normalizeOutboundPhone(rawPhone)
      if (!phone) return { success: false, error: 'নম্বরটি ঠিক নয় — 01XXXXXXXXX বা +880… দিন।' }

      const firstMessage = String(input.firstMessage ?? '').trim() || 'আসসালামু আলাইকুম।'
      const pref = input.ownerVoicePref as { gender?: 'male' | 'female' } | undefined
      const voiceGender: 'male' | 'female' = pref?.gender === 'male' ? 'male' : callType === 'staff' ? 'male' : 'female'
      const who = recipientName ?? phone
      const whenLabel = dueAt.toLocaleString('en-US', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' })
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'schedule_call',
          payload: { toNumber: phone, phone, recipientName, purpose, firstMessage, callType, voiceGender, dueAt: dueAt.toISOString() },
          summary: `⏰📞 ${who} কে ${whenLabel}-এ কল শিডিউল — "${purpose.slice(0, 50)}"`,
          costEstimate: 0.5,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: { status: 'confirm_required', pendingActionId: action.id, message: `${who} কে ${whenLabel}-এ কল শিডিউল করতে confirm করুন।` },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const list_scheduled_calls: AgentTool = {
  name: 'list_scheduled_calls',
  description: 'Lists upcoming scheduled two-way calls (status=scheduled), soonest first. Use when the owner asks "কী কী কল শিডিউল আছে"।',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const rows = await db.scheduledCall.findMany({
        where: { status: 'scheduled' },
        orderBy: { dueAt: 'asc' },
        take: 25,
        select: { id: true, recipientName: true, toNumber: true, purpose: true, dueAt: true, callType: true },
      })
      return {
        success: true,
        data: rows.map((r: { id: string; recipientName: string | null; toNumber: string; purpose: string; dueAt: Date; callType: string }) => ({
          id: r.id,
          who: r.recipientName ?? r.toNumber,
          purpose: r.purpose,
          dueAt: r.dueAt,
          when: new Date(r.dueAt).toLocaleString('en-US', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }),
          callType: r.callType,
        })),
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const cancel_scheduled_call: AgentTool = {
  name: 'cancel_scheduled_call',
  description: 'Cancels a scheduled two-way call by its id (from list_scheduled_calls). Use when the owner says "ঐ কলটা বাতিল করো"।',
  input_schema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'Scheduled call id from list_scheduled_calls.' } },
    required: ['id'],
  },
  handler: async (input) => {
    try {
      const id = String(input.id ?? '').trim()
      if (!id) return { success: false, error: 'id লাগবে' }
      const row = await db.scheduledCall.findUnique({ where: { id }, select: { status: true, recipientName: true, toNumber: true } })
      if (!row) return { success: false, error: 'ঐ শিডিউল কলটা পাওয়া যায়নি।' }
      if (row.status !== 'scheduled') return { success: false, error: `কলটা ইতিমধ্যে ${row.status} — বাতিল করা যাবে না।` }
      await db.scheduledCall.update({ where: { id }, data: { status: 'cancelled' } })
      return { success: true, data: { message: `${row.recipientName ?? row.toNumber} কে কলের শিডিউল বাতিল করা হয়েছে।` } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const FAMILY_TOOLS: AgentTool[] = [
  add_family_contact,
  list_family_contacts,
  call_family_member,
  place_agent_call,
  schedule_call,
  list_scheduled_calls,
  cancel_scheduled_call,
]

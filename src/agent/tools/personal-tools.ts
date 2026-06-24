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
      name: { type: 'string' },
      relation: { type: 'string', description: 'মা/স্ত্রী/বাবা/ভাই etc.' },
      phone: { type: 'string' },
      notes: { type: 'string' },
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
      conversationId: { type: 'string' },
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
      conversationId: { type: 'string' },
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
      const who = recipientName ?? phone
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'agent_voice_call',
          payload: { phone, toNumber: phone, recipientName, purpose, firstMessage },
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

export const FAMILY_TOOLS: AgentTool[] = [
  add_family_contact,
  list_family_contacts,
  call_family_member,
  place_agent_call,
]

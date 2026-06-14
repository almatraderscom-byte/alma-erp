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

export const FAMILY_TOOLS: AgentTool[] = [
  add_family_contact,
  list_family_contacts,
  call_family_member,
]

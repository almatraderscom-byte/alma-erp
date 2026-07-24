import { prisma } from '@/lib/prisma'
import { normalizeOutboundPhone } from '@/lib/twilio/phone'
import { checkOutboundCallRateLimit } from '@/agent/lib/urgent-rate-limit'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Deterministic guard against the head model spamming duplicate call cards. Before creating
 * a new agent_voice_call confirm card, refuse if the SAME number already has a pending card
 * OR a call placed in the last few minutes. Owner-reported 2026-07-19: the model re-proposed
 * ~5 cards for one call, each approve dialing again — 4 real calls to one contact.
 * Returns a Bangla reason string if the call should be blocked, else null.
 */
export async function duplicateCallReason(phone: string): Promise<string | null> {
  const tenMinAgo = new Date(Date.now() - 10 * 60_000)
  const threeMinAgo = new Date(Date.now() - 3 * 60_000)
  // 1) An unresolved card for this number is already waiting.
  const pendings: Array<{ payload: unknown }> = await db.agentPendingAction.findMany({
    where: { type: 'agent_voice_call', status: 'pending', createdAt: { gte: tenMinAgo } },
    select: { payload: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  const hasPending = pendings.some((a) => {
    const p = (a.payload ?? {}) as { phone?: string; toNumber?: string }
    return p.phone === phone || p.toNumber === phone
  })
  if (hasPending) {
    return 'এই নম্বরে একটা কল কার্ড ইতিমধ্যে অনুমোদনের অপেক্ষায় আছে। নতুন কার্ড বানাবে না — ওই কার্ডটাই approve করতে বলো।'
  }
  // 2) A call to this number was placed very recently (initiated/ringing/completed).
  const recent = await db.agentVoiceCall.findFirst({
    where: { toNumber: phone, createdAt: { gte: threeMinAgo }, status: { in: ['initiated', 'ringing', 'completed'] } },
    select: { id: true },
  })
  if (recent) {
    return 'এই নম্বরে একটু আগেই একটা কল দেওয়া হয়েছে — আবার কল দেওয়ার দরকার নেই। আগের কলের ফল আসা পর্যন্ত অপেক্ষা করো।'
  }
  return null
}

export const add_family_contact: AgentTool = {
  name: 'add_family_contact',
  description:
    'CONTACT LIST-এ নম্বর সেভ করে (নাম, সম্পর্ক/পরিচয়, নম্বর, ঐচ্ছিক নোট) — family, বন্ধু, সাপ্লায়ার, ডেলিভারি — যে কেউ। Boss একটা নম্বর আর নাম বললেই ("এই নম্বরটা X-এর, সেভ করো") সাথে সাথে এক ধাপে এটা চালাও — memory-তে নয়, এখানেই। relation-এ পরিচয় দাও (বন্ধু/সাপ্লায়ার/ভাই ইত্যাদি)।',
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
    'CONTACT LIST পড়ে — সেভ করা সব contact (family/বন্ধু/সাপ্লায়ার/সবাই)। Boss কাউকে নাম ধরে কল/মেসেজ দিতে বললে নাম→নম্বর resolve করতে সবসময় প্রথমে ও শুধুমাত্র এটা চালাও — এক ধাপ; memory search/অন্য পথ নিষেধ। এখানে না পেলে Boss-কে নম্বর জিজ্ঞেস করো।',
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
      channel: {
        type: 'string',
        enum: ['phone', 'whatsapp'],
        description: 'Where to place the live call: "phone" (default, ordinary call) or "whatsapp" (WhatsApp voice call to the same number — use when the owner says WhatsApp-e call koro). Same live two-way conversation either way.',
      },
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

      // Deterministic anti-spam: refuse a duplicate card if this number already has one
      // pending or was just called (head model was re-proposing the same call every turn).
      const dup = await duplicateCallReason(phone)
      if (dup) return { success: true, data: { status: 'duplicate', message: dup } }

      const firstMessage = String(input.firstMessage ?? '').trim() || 'আসসালামু আলাইকুম, কেমন আছেন?'
      // Voice = Boss's words (male → ashutosh/v3, female → anushka/v2). Resolved from his
      // recent messages via the server-injected ownerVoicePref; silence → female default.
      const pref = input.ownerVoicePref as { gender?: 'male' | 'female' } | undefined
      const voiceGender: 'male' | 'female' = pref?.gender === 'male' ? 'male' : 'female'
      const who = recipientName ?? phone
      const channel = input.channel === 'whatsapp' ? 'whatsapp' : 'phone'

      // PA-5R — the boss ordered this call VERBALLY on a live owner-verified call
      // (server-injected flag, model can't spoof it: serverContext wins the merge).
      // His spoken word IS the approval — dial now, no card. The duplicate guard
      // and rate limit above still apply; the post-call summary reports back.
      if (input.voiceCallInstruction === true) {
        const action = await db.agentPendingAction.create({
          data: {
            conversationId: input.conversationId ? String(input.conversationId) : null,
            type: 'agent_voice_call',
            payload: { phone, toNumber: phone, recipientName, purpose, firstMessage, voiceGender, callType: 'contact', channel, voiceApproved: true },
            summary: `${channel === 'whatsapp' ? '💬📞' : '📞'} ${who} কে লাইভ কল (কলে Boss-এর মুখের অনুমোদন) — "${purpose.slice(0, 60)}"`,
            costEstimate: 0.5,
            status: 'approved',
            resolvedAt: new Date(),
          },
        })
        const { placeOutboundCall } = await import('@/agent/lib/voice-call')
        const placed = await placeOutboundCall({
          toNumber: phone,
          recipientName,
          purpose,
          firstMessage,
          voiceGender,
          callType: 'contact',
          channel,
          conversationId: input.conversationId ? String(input.conversationId) : null,
          pendingActionId: action.id,
        })
        if (!placed.ok) {
          await db.agentPendingAction.update({
            where: { id: action.id },
            data: { status: 'failed', result: { error: placed.error } },
          }).catch(() => {})
          return { success: false, error: `কল দেওয়া যায়নি: ${placed.error ?? 'অজানা কারণ'}` }
        }
        return {
          success: true,
          data: {
            status: 'dialing',
            callRecordId: placed.callRecordId,
            message: `${who} কে কল দিচ্ছি (Boss কলে বলেছিলেন, তাই card ছাড়াই)। কথা শেষে সারাংশ আসবে — Boss রিপোর্ট চাইলে call_boss_with_report দিয়ে জানাও।`,
          },
        }
      }

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'agent_voice_call',
          payload: { phone, toNumber: phone, recipientName, purpose, firstMessage, voiceGender, callType: 'contact', channel },
          summary: `${channel === 'whatsapp' ? '💬📞' : '📞'} ${who} কে ${channel === 'whatsapp' ? 'WhatsApp-এ ' : ''}লাইভ কল — "${purpose.slice(0, 60)}"`,
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

/**
 * PA-5R — human-PA callback: the boss asked "কাজ শেষ হলে আমাকে কল করে জানাবে"।
 * When the work is done, this places a REAL call TO THE BOSS (WhatsApp live
 * first, unanswered → direct number, still unreached → push with the report)
 * via the PA-2 escalation ladder. NO approval card — the boss's own request IS
 * the consent (trigger boss_callback bypasses the permission card, rides its
 * own daily cap). Owner numbers only, enforced server-side by the ladder.
 */
export const call_boss_with_report: AgentTool = {
  name: 'call_boss_with_report',
  description:
    'Boss-কে ফোন কল করে কাজের রিপোর্ট শোনায় (human-PA callback)। ব্যবহার করো ঠিক তখনই ' +
    'যখন Boss নিজে বলেছিলেন কাজ শেষে জানাতে/কল করতে ("শেষ হলে জানাবে", "কল করে জানিও", ' +
    '"confirm দিবে") — এবং কাজটা এইমাত্র সত্যিই শেষ হয়েছে (tool-verified)। WhatsApp লাইভ কল ' +
    'যায় আগে, না ধরলে সরাসরি নম্বরে, তাও না ধরলে report push হয়। কোনো card লাগে না — Boss-এর ' +
    'অনুরোধটাই অনুমতি। report হবে ২-৪ বাক্যের পরিষ্কার বাংলা — কী করা হলো, ফলাফল কী, পরের ধাপ কী।',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'কাজের এক-লাইনের শিরোনাম (বাংলা), যেমন "ইয়াফিকে মেসেজ পাঠানো"।' },
      report: { type: 'string', description: 'কলে যা বলা হবে — ২-৪ বাক্যের বাংলা রিপোর্ট (কী করলে, ফলাফল, পরের ধাপ)।' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['title', 'report'],
  },
  handler: async (input) => {
    try {
      const title = String(input.title ?? '').trim().slice(0, 120)
      const report = String(input.report ?? '').trim()
      if (!title || !report) return { success: false, error: 'title এবং report দুটোই লাগবে' }

      // PA-5R precision guard (live complaint 2026-07-24: sales-update ask in the
      // app's voice session got answered AND phoned — history imitation). The
      // server derived callbackRequested from the boss's own recent words; without
      // his explicit call-words this tool is refused, model claims notwithstanding.
      if (input.callbackRequested !== true) {
        return {
          success: false,
          error:
            'Boss কল করে জানাতে বলেননি (ওনার কথায় "কল/ফোন করে জানাবে" নেই) — উত্তরটা এখানেই দিন। ' +
            'শুধু Boss নিজে কল-রিপোর্ট চাইলে এই tool।',
        }
      }
      // One report call at a time — a retry/self-correct round must not stack
      // multiple ladders that ring the boss back-to-back (live 2026-07-24: 3 rows).
      const activeCb = await db.agentCallEscalation.findFirst({
        where: { trigger: 'boss_callback', status: { in: ['queued', 'awaiting_approval', 'wa_calling', 'pstn_calling'] } },
        select: { id: true },
      })
      if (activeCb) {
        return {
          success: true,
          data: { status: 'already_calling', escalationId: activeCb.id, message: 'Boss-কে একটা কল-রিপোর্ট ইতিমধ্যে চলছে — নতুন কল দেব না।' },
        }
      }

      const { queueCallEscalation } = await import('@/agent/lib/proactive-call')
      const conv = input.conversationId ? String(input.conversationId) : 'chat'
      const id = await queueCallEscalation({
        trigger: 'boss_callback',
        refId: `callback:${conv}:${Date.now()}`,
        title,
        purpose:
          `Boss চেয়েছিলেন কাজ শেষে কল করে জানাতে। কাজ: ${title}। রিপোর্টটা Boss-কে পরিষ্কারভাবে শোনাও: ${report}`,
      })
      if (!id) return { success: false, error: 'callback queue করা যায়নি (owner number config দেখুন)' }
      return {
        success: true,
        data: {
          status: 'callback_queued',
          escalationId: id,
          message: 'Boss-কে কল যাচ্ছে (WhatsApp আগে, না ধরলে সরাসরি নম্বরে; তাও না ধরলে report push)।',
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

export const get_call_history: AgentTool = {
  name: 'get_call_history',
  description:
    'Returns the call log — recent phone calls (both INCOMING to the ALMA number and OUTGOING made by the agent) with who / direction / duration / est. cost / status / Bangla summary, plus any UPCOMING scheduled calls. Use when the owner asks "কল হিস্ট্রি / সাম্প্রতিক কল / কে কল করেছিল / কী কল বাকি আছে দেখাও"।',
  input_schema: {
    type: 'object' as const,
    properties: { limit: { type: 'number', description: 'How many recent calls (default 12, max 30).' } },
  },
  handler: async (input) => {
    try {
      const limit = Math.min(30, Math.max(1, Number(input.limit) || 12))
      const [calls, scheduled] = await Promise.all([
        db.agentVoiceCall.findMany({
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { recipientName: true, toNumber: true, purpose: true, status: true, durationSecs: true, costCredits: true, summary: true, createdAt: true },
        }),
        db.scheduledCall.findMany({
          where: { status: 'scheduled' },
          orderBy: { dueAt: 'asc' },
          take: 15,
          select: { recipientName: true, toNumber: true, purpose: true, dueAt: true, callType: true },
        }),
      ])
      const fmt = (d: Date) => new Date(d).toLocaleString('en-US', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' })
      return {
        success: true,
        data: {
          recent: calls.map((c: { recipientName: string | null; toNumber: string; purpose: string | null; status: string; durationSecs: number | null; costCredits: number | null; summary: string | null; createdAt: Date }) => ({
            who: c.recipientName ?? c.toNumber,
            direction: c.purpose === 'inbound_call' ? 'incoming' : 'outgoing',
            status: c.status,
            durationSecs: c.durationSecs,
            costBdt: c.costCredits,
            summary: c.summary,
            at: fmt(c.createdAt),
          })),
          upcoming: scheduled.map((s: { recipientName: string | null; toNumber: string; purpose: string; dueAt: Date; callType: string }) => ({
            who: s.recipientName ?? s.toNumber,
            purpose: s.purpose,
            when: fmt(s.dueAt),
            callType: s.callType,
          })),
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
  schedule_call,
  list_scheduled_calls,
  cancel_scheduled_call,
  get_call_history,
]

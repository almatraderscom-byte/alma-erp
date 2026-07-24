/**
 * Human-PA point 2 (owner audit 2026-07-24) — business calls tied to ERP data.
 *
 * A human PA calls the CUSTOMER about their order (delivery confirm, payment
 * follow-up, courier chase) with the order open in front of them. This tool
 * resolves the order (read-only, same source as get_orders) into a
 * context-rich call brief and delegates the actual dialing to
 * place_agent_call — so the confirm-card flow, voice-approved direct dial,
 * duplicate guard and post-call summary all behave identically.
 */
import { listAgentOrders } from '@/lib/agent-api/orders.service'
import type { AgentTool } from './registry'
import { place_agent_call } from './personal-tools'

export const place_business_call: AgentTool = {
  name: 'place_business_call',
  description:
    'ব্যবসার কাজে CUSTOMER-কে লাইভ কল — order-এর তথ্যসহ (human-PA স্টাইল)। ব্যবহার: ডেলিভারি কনফার্ম ' +
    '("কাল ডেলিভারি, বাসায় থাকবেন?"), payment/বাকি ফলো-আপ, courier সমস্যায় খোঁজ, order নিয়ে যেকোনো কথা। ' +
    'orderNumber দিলে order-এর নাম/নম্বর/স্ট্যাটাস/টাকা নিজেই তুলে কল-brief বানায় — customer-এর নম্বর আলাদা করে লাগে না। ' +
    'সাধারণ (order-বিহীন) কলের জন্য place_agent_call-ই ব্যবহার করো। কথা শেষে সারাংশ আসে।',
  input_schema: {
    type: 'object' as const,
    properties: {
      orderNumber: { type: 'string', description: 'Order/invoice নম্বর — এটাই customer resolve করে।' },
      phone: { type: 'string', description: 'Order-এ নম্বর না থাকলে/অন্য নম্বরে কল করতে হলে (01XXXXXXXXX)।' },
      purpose: { type: 'string', description: 'কেন কল — বাংলায় (যেমন "কালকের ডেলিভারি কনফার্ম করা")।' },
      conversationId: { type: 'string', description: 'Server-managed — omit.' },
    },
    required: ['purpose'],
  },
  handler: async (input) => {
    try {
      const orderNumber = String(input.orderNumber ?? '').trim()
      const purpose = String(input.purpose ?? '').trim()
      if (!purpose) return { success: false, error: 'purpose লাগবে' }
      if (!orderNumber && !String(input.phone ?? '').trim()) {
        return { success: false, error: 'orderNumber বা phone — একটা দিন (order-বিহীন কলে place_agent_call)' }
      }

      let phone = String(input.phone ?? '').trim()
      let customerName: string | undefined
      let brief = purpose

      if (orderNumber) {
        const { orders } = await listAgentOrders({ limit: 100 })
        const order = orders.find((o) => (o.orderNumber ?? '') === orderNumber || o.id === orderNumber)
        if (!order) {
          return { success: false, error: `Order "${orderNumber}" পাওয়া যায়নি — নম্বরটা মিলিয়ে দেখুন।` }
        }
        if (!phone) phone = order.customerPhone ?? ''
        if (!phone) {
          return { success: false, error: `Order ${orderNumber}-এ customer-এর ফোন নম্বর নেই — নম্বরটা আলাদা করে দিন।` }
        }
        customerName = order.customerName ?? undefined
        brief =
          `তুমি ALMA-র পক্ষ থেকে customer-কে কল করছ (ভদ্র, আন্তরিক customer-service ভঙ্গি — ভেতরের হিসাব বলবে না)। ` +
          `Order #${order.orderNumber ?? order.id}: ${order.customerName ?? 'customer'}, ` +
          `স্ট্যাটাস ${order.status}, মোট ৳${order.totalAmount}${order.shippingCity ? `, ঠিকানা ${order.shippingCity}` : ''}। ` +
          `কলের উদ্দেশ্য: ${purpose}। দরকারি তথ্য জেনে/দিয়ে ভদ্রভাবে শেষ করো।`
      }

      // Delegate to place_agent_call — one dialing brain (card / voice-approved
      // direct dial / duplicate guard / summary all shared).
      return await place_agent_call.handler({
        phone,
        recipientName: customerName,
        purpose: brief,
        conversationId: input.conversationId,
        voiceCallInstruction: input.voiceCallInstruction,
        ownerVoicePref: input.ownerVoicePref,
      })
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const BUSINESS_CALL_TOOLS: AgentTool[] = [place_business_call]

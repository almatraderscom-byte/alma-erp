'use client'

import { motion } from 'framer-motion'
import { Card } from '@/components/ui'

const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

/**
 * Staff WhatsApp opt-in card (owner's idea to beat the 24h window cleanly).
 *
 * One tap opens WhatsApp with a pre-written message addressed TO the business
 * number; the staff member just hits Send. That inbound message opens WhatsApp's
 * 24-hour customer-service window, so the agent can then message that staff member
 * free-form for 24h WITHOUT an approved template.
 *
 * Dormant + safe: renders nothing until NEXT_PUBLIC_WA_BUSINESS_NUMBER is set, so it
 * can ship before WhatsApp is live and never shows a broken/empty button.
 */
export function StaffWhatsAppOptIn({ name }: { name?: string }) {
  const number = (process.env.NEXT_PUBLIC_WA_BUSINESS_NUMBER ?? '').replace(/\D/g, '')
  if (!number) return null

  const who = name?.trim() || 'ALMA team'
  const greeting =
    `আসসালামু আলাইকুম! আমি ${who} — অফিসের আপডেট ও নির্দেশনা WhatsApp-এ পেতে চাই ✅`
  const href = `https://wa.me/${number}?text=${encodeURIComponent(greeting)}`

  return (
    <motion.div variants={fadeUp}>
      <Card className="flex items-center gap-4 border-[#25D366]/30 bg-[#25D366]/[0.06] p-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#25D366]/15 text-2xl">
          💬
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-cream">WhatsApp-এ যুক্ত হন</span>
          <span className="block text-[11px] leading-snug text-muted">
            এক ট্যাপ — লেখা মেসেজটা শুধু <b>Send</b> করুন। তাহলে অফিস আপনাকে WhatsApp-এ আপডেট পাঠাতে পারবে।
          </span>
        </span>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-xl bg-[#25D366] px-4 py-2.5 text-[13px] font-bold text-white shadow-sm transition-transform active:scale-95"
        >
          WhatsApp
        </a>
      </Card>
    </motion.div>
  )
}

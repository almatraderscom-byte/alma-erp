'use client'

import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Card } from '@/components/ui'
import { StaffWhatsAppOptIn } from './StaffWhatsAppOptIn'

/**
 * Staff WhatsApp opt-in GATE (owner step 2) — kill-switched + FAIL-OPEN.
 *
 * When the owner turns the gate on (KV wa_staff_optin_gate = "on"), a staff member
 * who hasn't messaged the business WhatsApp today sees ONLY the opt-in card (the rest
 * of the home is locked) until they send it and refresh. It can NEVER accidentally
 * lock anyone: it renders children normally unless it has POSITIVELY confirmed the
 * gate is on AND the user hasn't opted in — any error, loading, missing WhatsApp
 * number, or unknown state falls through to the normal home.
 */
export function StaffWaGate({ name, children }: { name?: string; children: ReactNode }) {
  const [locked, setLocked] = useState(false) // default OPEN
  const [checking, setChecking] = useState(false)

  // If no business WhatsApp number is configured there's no way to opt in — never lock.
  const hasNumber = Boolean((process.env.NEXT_PUBLIC_WA_BUSINESS_NUMBER ?? '').replace(/\D/g, ''))

  const check = useCallback(() => {
    if (!hasNumber) { setLocked(false); return }
    setChecking(true)
    fetch('/api/portal/wa-optin-status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { gateEnabled?: boolean; optedInToday?: boolean }) => {
        setLocked(Boolean(j.gateEnabled) && j.optedInToday === false)
      })
      .catch(() => setLocked(false)) // fail-open
      .finally(() => setChecking(false))
  }, [hasNumber])

  useEffect(() => { check() }, [check])

  if (!locked) return <>{children}</>

  return (
    <div className="p-4 md:p-8">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-md space-y-4"
      >
        <Card gold className="p-5 text-center">
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-gold">দিনের শুরুতে</p>
          <h2 className="mt-1 text-lg font-black text-cream">WhatsApp-এ যুক্ত হয়ে আনলক করুন</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            আজকের কাজ শুরু করতে নিচের <b>WhatsApp</b> বাটনে চাপ দিন → লেখা মেসেজটা <b>Send</b> করুন। তারপর নিচের বাটনে চাপ দিন।
          </p>
        </Card>

        <StaffWhatsAppOptIn name={name} />

        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="w-full rounded-xl border border-gold-dim/30 bg-gold/[0.06] px-4 py-3 text-[13px] font-bold text-cream transition-transform active:scale-95 disabled:opacity-50"
        >
          {checking ? 'দেখছি…' : 'পাঠিয়েছি — আনলক করুন'}
        </button>
      </motion.div>
    </div>
  )
}

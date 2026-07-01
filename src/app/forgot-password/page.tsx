'use client'
import Link from 'next/link'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Card, Input } from '@/components/ui'
import toast from 'react-hot-toast'

// Shared with login + reset for a consistent premium first impression.
const AUTH_BG =
  'bg-[radial-gradient(circle_at_15%_15%,rgb(var(--c-accent)/0.18),transparent_42%),radial-gradient(circle_at_85%_85%,rgba(129,178,154,0.16),transparent_44%),linear-gradient(180deg,#1a1a20_0%,#202027_50%,#17171c_100%)]'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      })
      if (!res.ok) throw new Error('Request failed')
      setSent(true)
      toast.success('If an account exists, reset instructions were generated.')
    } catch {
      toast.error('Could not process request')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className={`min-h-[100dvh] flex flex-col items-center justify-center px-4 ${AUTH_BG}`}>
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-md"
      >
        <Card gold interactive className="bg-surface/85 p-8 shadow-elevated backdrop-blur-md">
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-gold-dim/50 bg-gold/15 text-sm font-black text-gold-lt shadow-gold-sm">
            A
          </div>
          <p className="text-[11px] font-black tracking-[0.2em] text-gold mb-2 text-center">ALMA ERP</p>
          <h1 className="text-xl font-bold text-cream text-center mb-1">Forgot password</h1>
          <p className="text-[11px] text-muted text-center mb-8">
            Enter your email — if an account exists, we&apos;ll issue a short-lived reset link.
          </p>
          {sent ? (
            <p className="text-sm text-muted text-center mb-4">
              Check your email inbox — or ask an administrator to reset your password from Users.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-muted">Email</span>
                <Input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <Button type="submit" variant="gold" className="w-full justify-center" disabled={loading} loading={loading}>
                {loading ? 'Sending…' : 'Send reset'}
              </Button>
            </form>
          )}
          <Link href="/login" className="mt-6 inline-block text-[11px] text-gold-lt hover:underline">← Back to login</Link>
        </Card>
      </motion.div>
    </main>
  )
}

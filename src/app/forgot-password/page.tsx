'use client'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui'
import toast from 'react-hot-toast'

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
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 bg-black">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8">
        <h1 className="text-lg font-bold text-cream mb-2">Forgot password</h1>
        <p className="text-[11px] text-muted mb-6">
          Enter your email. If an account exists, we&apos;ll issue a short-lived reset link (logged server-side for admins on dev stacks).
        </p>
        {sent ? (
          <p className="text-sm text-muted mb-4">Check your email inbox — or ask an administrator to reset your password from Users.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email"
              className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream"
            />
            <Button type="submit" variant="gold" className="w-full justify-center" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset'}
            </Button>
          </form>
        )}
        <Link href="/login" className="mt-6 inline-block text-[11px] text-gold-lt hover:underline">← Back to login</Link>
      </div>
    </div>
  )
}

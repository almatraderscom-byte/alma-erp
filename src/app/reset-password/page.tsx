'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { motion } from 'framer-motion'
import { Button, Card, Input } from '@/components/ui'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'
import toast from 'react-hot-toast'

// Shared with login + forgot for a consistent premium first impression.
const AUTH_BG =
  'bg-[radial-gradient(circle_at_15%_15%,rgba(224,122,95,0.18),transparent_42%),radial-gradient(circle_at_85%_85%,rgba(129,178,154,0.16),transparent_44%),linear-gradient(180deg,#1a1a20_0%,#202027_50%,#17171c_100%)]'

function ResetInner() {
  const params = useSearchParams()
  const token = params.get('token') || ''
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token) {
      toast.error('Missing token')
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Reset failed')
      toast.success('Password updated — sign in')
      window.location.href = '/login'
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reset failed')
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
          <h1 className="text-xl font-bold text-cream text-center mb-8">Reset password</h1>
          {!token ? (
            <p className="text-sm text-danger text-center">Invalid reset link.</p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-[10px] uppercase tracking-wider text-muted">New password</span>
                <Input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>
              <Button type="submit" variant="gold" className="w-full justify-center" disabled={loading} loading={loading}>
                {loading ? 'Saving…' : 'Update password'}
              </Button>
            </form>
          )}
          <Link href="/login" className="mt-6 inline-block text-[11px] text-gold-lt hover:underline">← Login</Link>
        </Card>
      </motion.div>
    </main>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingOverlay label="Preparing reset" />}>
      <ResetInner />
    </Suspense>
  )
}

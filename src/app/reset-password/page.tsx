'use client'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { Button } from '@/components/ui'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'
import toast from 'react-hot-toast'

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
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 bg-black">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8">
        <h1 className="text-lg font-bold text-cream mb-6">Reset password</h1>
        {!token ? (
          <p className="text-sm text-red-400">Invalid reset link.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="New password"
              className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream"
            />
            <Button type="submit" variant="gold" className="w-full justify-center" disabled={loading}>
              {loading ? 'Saving…' : 'Update password'}
            </Button>
          </form>
        )}
        <Link href="/login" className="mt-6 inline-block text-[11px] text-gold-lt hover:underline">← Login</Link>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<LoadingOverlay label="Preparing reset" />}>
      <ResetInner />
    </Suspense>
  )
}

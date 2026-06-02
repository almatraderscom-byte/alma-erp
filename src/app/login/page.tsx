'use client'
import { signIn } from 'next-auth/react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect, Suspense } from 'react'
import { safeAuthCallbackUrl } from '@/lib/auth-paths'
import { motion } from 'framer-motion'
import { Button, Card, Input } from '@/components/ui'
import toast from 'react-hot-toast'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const callbackUrl = safeAuthCallbackUrl(params.get('callbackUrl'))
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const raw = params.get('callbackUrl')
    if (!raw || safeAuthCallbackUrl(raw) === raw) return
    router.replace('/login')
  }, [params, router])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await signIn('credentials', {
        identifier: identifier.trim(),
        password,
        redirect: false,
        callbackUrl,
      })
      if (res?.error) {
        toast.error('Invalid phone/email or password')
        setLoading(false)
        return
      }
      router.replace(callbackUrl)
    } catch {
      toast.error('Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-[100dvh] flex flex-col items-center justify-center px-4 bg-[radial-gradient(circle_at_top,rgba(201,168,76,0.14),transparent_34%),linear-gradient(180deg,#08080a_0%,#000_48%,#0a0806_100%)]">
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        <Card gold className="bg-surface/85 backdrop-blur-md p-8 shadow-2xl shadow-black/60">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-gold-dim/50 bg-gold/15 text-sm font-black text-gold-lt shadow-gold-sm">
          A
        </div>
        <p className="text-[11px] font-black tracking-[0.2em] text-gold mb-2 text-center">ALMA ERP</p>
        <h1 className="text-xl font-bold text-cream text-center mb-1">Sign in</h1>
        <p className="text-[11px] text-zinc-500 text-center mb-8">Secure multi-business workspace</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Phone or Email</span>
            <Input
              type="text"
              inputMode="email"
              autoComplete="username"
              required
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              placeholder="+8801XXXXXXXXX or you@company.com"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Password</span>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </label>
          <Button type="submit" variant="gold" className="w-full justify-center py-3" disabled={loading}>
            {loading ? 'Signing in…' : 'Continue'}
          </Button>
        </form>

        <div className="mt-6 flex flex-col gap-2 text-center text-[11px] text-zinc-500">
          <Link href="/forgot-password" className="text-gold-lt hover:underline">Forgot password?</Link>
          <p className="text-[10px] leading-snug opacity-80">Use your assigned Alma ERP account.</p>
        </div>
        </Card>
      </motion.div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-[100dvh] bg-black" />}>
      <LoginForm />
    </Suspense>
  )
}

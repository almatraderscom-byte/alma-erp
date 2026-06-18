'use client'
import { getSession, signIn } from 'next-auth/react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect, Suspense } from 'react'
import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { safeAuthCallbackUrl } from '@/lib/auth-paths'
import { motion } from 'framer-motion'
import { Button, Card, Input } from '@/components/ui'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'
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

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      void fetchWithTimeout('/api/auth/session', { cache: 'no-store', credentials: 'same-origin' }, 8_000)
        .then(async res => {
          if (!alive || !res.ok) return
          const body = await res.json().catch(() => null)
          if (!body?.user) return
          try {
            const guard = sessionStorage.getItem('alma_auth_redirect_guard')
            if (guard) {
              const parsed = JSON.parse(guard) as { count: number; at: number }
              if (parsed.count >= 2 && Date.now() - parsed.at < 30_000) return
            }
          } catch {
            /* ignore */
          }
          window.location.href = callbackUrl
        })
        .catch(() => {})
    }, 800)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [callbackUrl])

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
      if (!res?.ok) {
        toast.error('Login failed')
        setLoading(false)
        return
      }

      await new Promise(r => setTimeout(r, 350))
      let session = await getSession()
      for (let i = 0; i < 4 && !session?.user; i++) {
        await new Promise(r => setTimeout(r, 400))
        session = await getSession()
      }

      if (session?.user) {
        try {
          sessionStorage.removeItem('alma_auth_redirect_guard')
        } catch {
          /* ignore */
        }
        window.location.href = callbackUrl
        return
      }

      toast.error('Login successful but session not ready. Please refresh.')
      setLoading(false)
    } catch {
      toast.error('Login failed')
      setLoading(false)
    }
  }

  return (
    <main className="min-h-[100dvh] flex flex-col items-center justify-center px-4 bg-[radial-gradient(circle_at_15%_15%,rgba(224,122,95,0.18),transparent_42%),radial-gradient(circle_at_85%_85%,rgba(129,178,154,0.16),transparent_44%),linear-gradient(180deg,#1a1a20_0%,#202027_50%,#17171c_100%)]">
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
        <h1 className="text-xl font-bold text-cream text-center mb-1">Sign in</h1>
        <p className="text-[11px] text-muted text-center mb-8">Secure multi-business workspace</p>

        <form onSubmit={onSubmit} className="space-y-4" data-login-form>
          <label className="block space-y-1">
            <span className="text-[10px] uppercase tracking-wider text-muted">Phone or Email</span>
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
            <span className="text-[10px] uppercase tracking-wider text-muted">Password</span>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </label>
          <Button type="submit" variant="gold" className="w-full justify-center py-3" loading={loading}>
            Continue
          </Button>
        </form>

        <div className="mt-6 flex flex-col gap-2 text-center text-[11px] text-muted">
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
    <Suspense fallback={<LoadingOverlay label="Loading login" />}>
      <LoginForm />
    </Suspense>
  )
}

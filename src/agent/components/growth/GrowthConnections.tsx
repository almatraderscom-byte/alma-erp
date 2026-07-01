'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

type GscStatus = {
  configured: boolean
  connected: boolean
  email: string | null
  connectedAt: string | null
  sites: string[] | null
  sitesError: string | null
}

const CONNECT_URL = '/api/assistant/growth/gsc-auth'
const STATUS_URL = '/api/assistant/growth/gsc-status'

function bannerFor(flag: string | null): { text: string; tone: 'ok' | 'warn' } | null {
  switch (flag) {
    case 'connected':
      return { text: 'Google Search Console যুক্ত হয়েছে ✓', tone: 'ok' }
    case 'denied':
      return { text: 'অনুমতি বাতিল হয়েছে — আবার চেষ্টা করুন।', tone: 'warn' }
    case 'error':
      return { text: 'সংযোগে সমস্যা হয়েছে — আবার চেষ্টা করুন।', tone: 'warn' }
    case 'no_code':
      return { text: 'Google থেকে code আসেনি — আবার চেষ্টা করুন।', tone: 'warn' }
    default:
      return null
  }
}

export default function GrowthConnections() {
  const [gsc, setGsc] = useState<GscStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [banner, setBanner] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(STATUS_URL, { cache: 'no-store' })
      if (res.ok) setGsc(await res.json())
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Surface the OAuth callback result, then clean the URL.
    const params = new URLSearchParams(window.location.search)
    const b = bannerFor(params.get('gsc'))
    if (b) {
      setBanner(b)
      window.history.replaceState(null, '', '/agent/growth')
    }
    void load()
  }, [load])

  const onDisconnect = useCallback(async () => {
    try {
      await fetch(STATUS_URL, { method: 'DELETE' })
      setGsc((s) => (s ? { ...s, connected: false, email: null, connectedAt: null, sites: null } : s))
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 px-4 py-6 safe-top safe-x">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-[#E07A5F]">Growth — সংযোগ</span>
        </div>
        <Link
          href="/agent"
          className="rounded-xl border border-border-subtle bg-card/60 px-3 py-1.5 text-[11px] font-semibold text-muted transition-all hover:text-cream"
        >
          ‹ চ্যাটে ফিরুন
        </Link>
      </div>

      <p className="text-[12px] leading-relaxed text-muted">
        এখান থেকে Google-এর ফ্রি ডেটা সোর্সগুলো একবার যুক্ত করুন। যুক্ত হলে এজেন্ট আসল search ডেটা দিয়ে SEO সিদ্ধান্ত নিতে পারবে
        (Oxylabs খরচ ছাড়াই)।
      </p>

      {banner && (
        <div
          className={`rounded-xl border px-3 py-2 text-[12px] font-semibold ${
            banner.tone === 'ok'
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400'
              : 'border-amber-400/30 bg-amber-400/10 text-amber-400'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* Google Search Console card */}
      <div className="glass-panel rounded-2xl border border-border-subtle p-4">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#4285F4]/10 text-[#4285F4]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-cream">Google Search Console</p>
            <p className="text-[11px] text-muted">আসল Google search ডেটা — impressions, clicks, position, top queries</p>
          </div>
        </div>

        {loading ? (
          <p className="text-[12px] text-muted">লোড হচ্ছে…</p>
        ) : !gsc?.configured ? (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
            OAuth client সেট করা নেই। Vercel-এ <code className="font-mono">GSC_CLIENT_ID</code> ও{' '}
            <code className="font-mono">GSC_CLIENT_SECRET</code> সেট করুন (অথবা বিদ্যমান{' '}
            <code className="font-mono">GOOGLE_DRIVE_CLIENT_ID/SECRET</code> রি-ইউজ হবে)।
          </div>
        ) : gsc.connected ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-emerald-400">যুক্ত আছে ✓</p>
                {gsc.email && <p className="truncate text-[10px] text-emerald-400/70">{gsc.email}</p>}
              </div>
              <button
                type="button"
                onClick={() => void onDisconnect()}
                className="shrink-0 text-[11px] font-semibold text-muted transition-colors hover:text-cream"
              >
                বিচ্ছিন্ন করুন
              </button>
            </div>

            {gsc.sitesError ? (
              <p className="text-[11px] text-amber-400">Property তালিকা আনা যায়নি: {gsc.sitesError}</p>
            ) : gsc.sites && gsc.sites.length > 0 ? (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Properties</p>
                <ul className="space-y-1">
                  {gsc.sites.map((s) => (
                    <li key={s} className="truncate rounded-lg bg-card/60 px-2 py-1 font-mono text-[11px] text-cream">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[11px] text-amber-400">এই account-এ কোনো Search Console property নেই।</p>
            )}
          </div>
        ) : (
          <a
            href={CONNECT_URL}
            className="flex items-center justify-center gap-2 rounded-xl border border-[#4285F4]/30 bg-[#4285F4]/[0.08] px-3 py-2.5 text-[12px] font-semibold text-[#4285F4] transition-all hover:bg-[#4285F4]/[0.14]"
          >
            Google Search Console যুক্ত করুন
          </a>
        )}
      </div>
    </div>
  )
}

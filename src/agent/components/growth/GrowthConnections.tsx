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
const FEATURE_STATUS_URL = '/api/assistant/growth/feature-status'
const META_CONNECT_URL = '/api/assistant/meta-mcp/auth'
const META_STATUS_URL = '/api/assistant/meta-mcp/status'

type MetaMcpStatus = {
  envEnabled: boolean
  kvEnabled: boolean
  enabled: boolean
  connected: boolean
  tier: 'read' | 'write' | 'financial'
  connectedAt: string | null
  tokenHealth: string
  registeredReadTools: number
  remoteToolCount: number | null
  adAccounts: Array<{ id?: string; name?: string }> | null
  probeError: string | null
}

type FeatureStatus = {
  generatedAt?: string
  gscConnected: boolean
  ga4: { state: string; propertyId: string | null; sessions7d: number | null; error?: string }
  gbp: { state: string; location?: string; error?: string }
  indexnow: { state: string; keyFileLive: boolean }
  campaigns: {
    sms: { state: string; balance: string | null; error?: string }
    email: { state: string; domain: string | null }
  }
  finalSubmitBan: { serverLayer: boolean }
}

type Tone = 'ok' | 'warn' | 'pending'

/** One row of the growth board: status dot + title + detail + optional action hint. */
function StatusRow(props: { tone: Tone; icon: string; title: string; detail: string; action?: string; actionHref?: string }) {
  const dot =
    props.tone === 'ok' ? 'bg-emerald-400' : props.tone === 'pending' ? 'bg-sky-400' : 'bg-amber-400'
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-card/60 px-3 py-2.5">
      <span className="mt-0.5 text-[15px] leading-none">{props.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <p className="text-[12px] font-bold text-cream">{props.title}</p>
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{props.detail}</p>
        {props.action &&
          (props.actionHref ? (
            <a
              href={props.actionHref}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[11px] font-semibold text-amber-400 underline underline-offset-2"
            >
              → {props.action}
            </a>
          ) : (
            <p className="mt-1 text-[11px] font-semibold text-amber-400">→ {props.action}</p>
          ))}
      </div>
    </div>
  )
}

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

function metaBannerFor(flag: string | null): { text: string; tone: 'ok' | 'warn' } | null {
  switch (flag) {
    case 'connected':
      return { text: 'Meta Ads যুক্ত হয়েছে ✓ (read-only)', tone: 'ok' }
    case 'denied':
      return { text: 'Meta অনুমতি বাতিল হয়েছে — আবার চেষ্টা করুন।', tone: 'warn' }
    case 'error':
      return { text: 'Meta সংযোগে সমস্যা হয়েছে — আবার চেষ্টা করুন।', tone: 'warn' }
    case 'no_code':
      return { text: 'Meta থেকে code আসেনি — আবার চেষ্টা করুন।', tone: 'warn' }
    case 'disabled':
      return { text: 'Meta Ads MCP সার্ভারে চালু নেই (META_MCP_ENABLED)।', tone: 'warn' }
    default:
      return null
  }
}

const META_TIER_LABEL: Record<string, string> = {
  read: 'read-only — শুধু রিপোর্ট/ইনসাইট, টাকার কোনো ঝুঁকি নেই',
  write: 'read/write — ক্যাম্পেইন তৈরি (Approve-কার্ডের পেছনে)',
  financial: 'read/write/financial — বাজেটসহ (Approve-কার্ডের পেছনে)',
}

export default function GrowthConnections() {
  const [gsc, setGsc] = useState<GscStatus | null>(null)
  const [meta, setMeta] = useState<MetaMcpStatus | null>(null)
  const [metaLoading, setMetaLoading] = useState(true)
  const [features, setFeatures] = useState<FeatureStatus | null>(null)
  const [featuresLoading, setFeaturesLoading] = useState(true)
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
    // Meta Ads MCP status probes the live server when connected — loads
    // independently so it never holds up the GSC card (and vice versa).
    setMetaLoading(true)
    try {
      const res = await fetch(META_STATUS_URL, { cache: 'no-store' })
      if (res.ok) setMeta(await res.json())
    } catch {
      /* ignore */
    } finally {
      setMetaLoading(false)
    }
    // The feature board probes live APIs (GA4/GBP/storefront) — slower, so it
    // loads independently and never holds up the GSC card.
    setFeaturesLoading(true)
    try {
      const res = await fetch(FEATURE_STATUS_URL, { cache: 'no-store' })
      if (res.ok) setFeatures(await res.json())
    } catch {
      /* ignore */
    } finally {
      setFeaturesLoading(false)
    }
  }, [])

  useEffect(() => {
    // Surface the OAuth callback result, then clean the URL.
    const params = new URLSearchParams(window.location.search)
    const b = bannerFor(params.get('gsc')) ?? metaBannerFor(params.get('meta'))
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

  const onMetaDisconnect = useCallback(async () => {
    try {
      await fetch(META_STATUS_URL, { method: 'DELETE' })
      setMeta((s) => (s ? { ...s, connected: false, connectedAt: null, adAccounts: null, tokenHealth: 'none' } : s))
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

      {/* Meta Ads (official MCP) card — Phase MA1, read-only */}
      <div className="glass-panel rounded-2xl border border-border-subtle p-4">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#0866FF]/10 text-[#0866FF]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17l4-9 4 7 3-5 4 7" />
              <path d="M3 21h18" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-cream">Meta Ads (অফিসিয়াল MCP)</p>
            <p className="text-[11px] text-muted">আসল অ্যাড ডেটা — পারফরম্যান্স ট্রেন্ড, বেঞ্চমার্ক, ক্যাটালগ, ডায়াগনস্টিকস</p>
          </div>
        </div>

        {metaLoading ? (
          <p className="text-[12px] text-muted">লোড হচ্ছে…</p>
        ) : !meta ? (
          <p className="text-[12px] text-amber-400">স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।</p>
        ) : !meta.envEnabled ? (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
            চালু নেই। Vercel-এ <code className="font-mono">META_MCP_ENABLED=true</code> সেট করুন — তারপর এখান থেকে connect করা যাবে।
          </div>
        ) : !meta.kvEnabled ? (
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-400">
            এজেন্ট-সেটিংসে বন্ধ করা আছে (<code className="font-mono">meta_mcp_enabled=off</code>)। চ্যাটে এজেন্টকে চালু করতে বলুন।
          </div>
        ) : meta.connected ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold text-emerald-400">
                  যুক্ত আছে ✓ — {meta.tier === 'read' ? 'read-only' : meta.tier}
                </p>
                <p className="truncate text-[10px] text-emerald-400/70">{META_TIER_LABEL[meta.tier] ?? ''}</p>
              </div>
              <button
                type="button"
                onClick={() => void onMetaDisconnect()}
                className="shrink-0 text-[11px] font-semibold text-muted transition-colors hover:text-cream"
              >
                বিচ্ছিন্ন করুন
              </button>
            </div>

            {meta.tokenHealth === 'reconnect_needed' && (
              <p className="text-[11px] text-amber-400">Token-এর মেয়াদ শেষ — আবার connect করুন।</p>
            )}

            {meta.adAccounts && meta.adAccounts.length > 0 ? (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Ad accounts</p>
                <ul className="space-y-1">
                  {meta.adAccounts.map((a, i) => (
                    <li key={a.id ?? i} className="truncate rounded-lg bg-card/60 px-2 py-1 font-mono text-[11px] text-cream">
                      {a.name ?? a.id ?? 'account'}
                      {a.name && a.id ? ` (${a.id})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : meta.probeError ? (
              <p className="text-[11px] text-amber-400">Ad account তালিকা আনা যায়নি: {meta.probeError}</p>
            ) : null}

            <p className="text-[11px] text-muted">
              {meta.registeredReadTools}টি read টুল এজেন্টে যুক্ত
              {meta.remoteToolCount != null ? ` — Meta সার্ভারে মোট ${meta.remoteToolCount}টি` : ''}।
            </p>

            {/* MA3 tier upgrade — re-connect at write scope to draft campaigns.
                Every write still lands as a PAUSED Approve-card; nothing spends
                without the owner. Shown once connected, only while still read-only. */}
            {meta.tier === 'read' && (
              <a
                href={`${META_CONNECT_URL}?tier=write`}
                className="flex items-center justify-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 text-[11px] font-semibold text-amber-400 transition-all hover:bg-amber-400/[0.14]"
              >
                লেখা-অনুমতি যোগ করুন (ক্যাম্পেইন তৈরি — Approve-কার্ডের পেছনে)
              </a>
            )}
            {meta.tier !== 'read' && (
              <p className="text-[11px] font-semibold text-emerald-400/80">
                লেখা-অনুমতি সক্রিয় — ক্যাম্পেইন তৈরি/এডিট Approve-কার্ডের পেছনে, activate আলাদা লাল কার্ডে।
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <a
              href={META_CONNECT_URL}
              className="flex items-center justify-center gap-2 rounded-xl border border-[#0866FF]/30 bg-[#0866FF]/[0.08] px-3 py-2.5 text-[12px] font-semibold text-[#0866FF] transition-all hover:bg-[#0866FF]/[0.14]"
            >
              Meta Ads যুক্ত করুন (read-only)
            </a>
            <p className="text-[11px] leading-relaxed text-muted">
              এক ক্লিকে Meta-র Business অনুমতি — শুধু-পড়া (রিপোর্ট/ইনসাইট), টাকার কোনো ঝুঁকি নেই। পরে Business
              Suite → Business Integrations থেকে যেকোনো সময় revoke করা যায়।
            </p>
          </div>
        )}
      </div>

      {/* Growth feature status board (Features 1-8) */}
      <div className="glass-panel rounded-2xl border border-border-subtle p-4">
        <p className="mb-1 text-[13px] font-bold text-cream">গ্রোথ ফিচার স্ট্যাটাস</p>
        <p className="mb-3 text-[11px] text-muted">
          সব integration-এর এখনকার আসল অবস্থা — সবুজ = চলছে, হলুদ = আপনার একটা কাজ বাকি, নীল = অন্যের অনুমোদনের অপেক্ষা।
        </p>
        {featuresLoading ? (
          <p className="text-[12px] text-muted">লাইভ স্ট্যাটাস আনা হচ্ছে…</p>
        ) : !features ? (
          <p className="text-[12px] text-amber-400">স্ট্যাটাস আনা যায়নি — পেজ রিফ্রেশ করুন।</p>
        ) : (
          <div className="space-y-2">
            <StatusRow
              tone={features.gscConnected ? 'ok' : 'warn'}
              icon="🔍"
              title="Search Console (SEO ডেটা)"
              detail={features.gscConnected ? 'যুক্ত আছে — আসল search ডেটা আসছে।' : 'যুক্ত নেই।'}
              action={features.gscConnected ? undefined : 'উপরের বাটন থেকে connect করুন'}
            />
            <StatusRow
              tone={features.ga4.state === 'ok' ? 'ok' : 'warn'}
              icon="📊"
              title="Google Analytics (ট্রাফিক ও ROI)"
              detail={
                features.ga4.state === 'ok'
                  ? `চলছে — গত ৭ দিনে ${features.ga4.sessions7d ?? 0}টি ভিজিট (property ${features.ga4.propertyId})।`
                  : features.ga4.state === 'needs_env'
                    ? 'GA4_PROPERTY_ID সেট করা নেই।'
                    : features.ga4.state === 'needs_reconnect'
                      ? 'Analytics permission নেই — আবার connect করুন।'
                      : features.ga4.state === 'needs_connect'
                        ? 'Google connect করা নেই।'
                        : features.ga4.state === 'timeout'
                          ? 'Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।'
                          : `সমস্যা: ${features.ga4.error ?? 'অজানা'}`
              }
            />
            <StatusRow
              tone={features.gbp.state === 'ok' ? 'ok' : features.gbp.state === 'pending_google' ? 'pending' : 'warn'}
              icon="📍"
              title="Business Profile (Google রিভিউ)"
              detail={
                features.gbp.state === 'ok'
                  ? `চলছে — location: ${features.gbp.location || 'পাওয়া গেছে'}।`
                  : features.gbp.state === 'pending_google'
                    ? 'কোড রেডি — Google-এর API access অনুমোদনের অপেক্ষায় (form submit করলে কয়েক দিনে চালু হবে)।'
                    : features.gbp.state === 'needs_reconnect'
                      ? 'Business Profile permission নেই — আবার connect করুন।'
                      : features.gbp.state === 'no_location'
                        ? 'এই Google account-এ কোনো Business Profile নেই।'
                        : features.gbp.state === 'needs_connect'
                          ? 'Google connect করা নেই।'
                          : features.gbp.state === 'timeout'
                            ? 'Google সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।'
                            : `সমস্যা: ${features.gbp.error ?? 'অজানা'}`
              }
              action={features.gbp.state === 'pending_google' ? 'Google-এর access form (project 207682606576)' : undefined}
              actionHref={features.gbp.state === 'pending_google' ? 'https://support.google.com/business/contact/api_default' : undefined}
            />
            <StatusRow
              tone={features.indexnow.state === 'ok' ? 'ok' : 'warn'}
              icon="⚡"
              title="IndexNow (দ্রুত re-crawl)"
              detail={
                features.indexnow.state === 'ok'
                  ? 'চলছে — key file লাইভ, SEO ফিক্সের পর Bing/Yandex সাথে সাথে জানবে।'
                  : features.indexnow.state === 'needs_env'
                    ? 'INDEXNOW_KEY সেট করা নেই।'
                    : 'Key file storefront-এ পাওয়া যাচ্ছে না।'
              }
            />
            <StatusRow
              tone={features.campaigns.sms.state === 'ok' ? 'ok' : 'warn'}
              icon="📱"
              title="SMS ক্যাম্পেইন (sms.net.bd)"
              detail={
                features.campaigns.sms.state === 'ok'
                  ? `চলছে — key যাচাই হয়েছে${features.campaigns.sms.balance != null ? `, ব্যালেন্স ৳${features.campaigns.sms.balance}` : ''}।`
                  : features.campaigns.sms.state === 'needs_env'
                    ? 'SMS_API_KEY সেট করা নেই।'
                    : features.campaigns.sms.state === 'bad_key'
                      ? `Key কাজ করছে না: ${features.campaigns.sms.error ?? 'provider error'}`
                      : 'Provider সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।'
              }
            />
            <StatusRow
              tone={features.campaigns.email.state === 'ok' ? 'ok' : features.campaigns.email.state === 'sandbox' ? 'warn' : 'warn'}
              icon="📧"
              title="Email ক্যাম্পেইন (Resend)"
              detail={
                features.campaigns.email.state === 'ok'
                  ? `চলছে — domain verified (${features.campaigns.email.domain}), কাস্টমারদের পাঠানো যাবে।`
                  : features.campaigns.email.state === 'sandbox'
                    ? 'Sandbox mode — শুধু নিজের ঠিকানায় যায়। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।'
                    : features.campaigns.email.state === 'send_only'
                      ? 'Key কাজ করছে (send-only) — পাঠানো যায়, তবে domain state check করা যায় না। কাস্টমারদের পাঠাতে Resend-এ almatraders.com verify করুন।'
                      : features.campaigns.email.state === 'needs_env'
                        ? 'RESEND_API_KEY সেট করা নেই।'
                        : features.campaigns.email.state === 'bad_key'
                          ? 'Resend key কাজ করছে না।'
                          : 'Resend সাড়া দিচ্ছে না (timeout) — একটু পরে রিফ্রেশ করুন।'
              }
              action={
                features.campaigns.email.state === 'sandbox' || features.campaigns.email.state === 'send_only'
                  ? 'Resend → Domains → Add almatraders.com'
                  : undefined
              }
              actionHref={
                features.campaigns.email.state === 'sandbox' || features.campaigns.email.state === 'send_only'
                  ? 'https://resend.com/domains'
                  : undefined
              }
            />
            <StatusRow
              tone="ok"
              icon="🛡️"
              title="Final-submit নিরাপত্তা (ব্রাউজার)"
              detail="Send/Pay/Delete-জাতীয় শেষ বাটন এজেন্ট আর চাপতে পারে না — কোড-লেভেলে ব্লক (server লেয়ার চালু)। Extension লেয়ারের জন্য chrome://extensions-এ একবার Reload।"
            />
          </div>
        )}
      </div>
    </div>
  )
}

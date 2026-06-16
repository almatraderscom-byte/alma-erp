'use client'

import { useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { PageHeader, Card, Button, Skeleton } from '@/components/ui'
import { motion } from 'framer-motion'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

type StatusJson = {
  databaseUrlConfigured: boolean
  databaseUrlHint: string
  postgresReachable: boolean
  prismaWorks: boolean
  userRowCount: number | null
  nextAuthSecretConfigured: boolean
  nextAuthUrl: string | null
  health?: {
    ok?: boolean
    env?: { ok: boolean; missing: string[]; placeholder: string[] }
    database?: { ok: boolean; wallet_ledger_ok: boolean; error?: string | null }
  }
  error?: string
}

function Row({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean | null
  detail?: string | null
}) {
  const tone =
    ok === null ? 'text-slate-500' : ok ? 'text-green-400' : 'text-red-400'
  const dot = ok === null ? 'bg-zinc-600' : ok ? 'bg-green-400' : 'bg-red-400'
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-black/[0.04] last:border-0">
      <div className="flex items-start gap-2 min-w-0">
        <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-slate-800">{label}</p>
          {detail ? <p className="text-[10px] text-slate-500 font-mono truncate">{detail}</p> : null}
        </div>
      </div>
      <span className={`text-[10px] font-bold uppercase shrink-0 ${tone}`}>
        {ok === null ? '…' : ok ? 'OK' : 'Issue'}
      </span>
    </div>
  )
}

export default function DatabaseSettingsPage() {
  const { data: session, status } = useSession()
  const [data, setData] = useState<StatusJson | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/settings/database-status', { cache: 'no-store' })
      const j = (await res.json()) as StatusJson & { error?: string }
      const healthRes = await fetch('/api/health', { cache: 'no-store' })
      const health = await healthRes.json().catch(() => null)
      setData({ ...j, health })
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sessionActive = status === 'authenticated' && Boolean(session?.user?.email)

  return (
    <>
      <PageHeader
        title="Database"
        subtitle="PostgreSQL · Prisma · NextAuth · session health"
      />
      <motion.div variants={stagger} initial="hidden" animate="show" className="p-4 md:p-6 max-w-xl space-y-4">
        <motion.div variants={fadeUp}>
          <Card className="p-5 border-gold-dim/25 bg-[#FAF9F6] space-y-1">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-gold">Connection</p>
            <p className="text-[11px] text-slate-500 leading-snug">
              Uses Supabase Postgres for ERP accounts and RBAC. Google Sheets behaviour is unchanged (
              <span className="font-mono text-slate-400">NEXT_PUBLIC_API_URL</span>
              ).
            </p>
            <p className="text-[11px] text-gold-lt mt-2 font-mono break-all">
              docs/SUPABASE_POSTGRES_SETUP.md
            </p>
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="p-5 space-y-3">
            <div className="flex justify-between items-center gap-2">
              <p className="text-sm font-bold text-slate-800">Live status</p>
              <Button size="xs" variant="secondary" type="button" onClick={() => void load()} disabled={loading}>
                Refresh
              </Button>
            </div>

            {loading ? (
              <Skeleton className="h-44 w-full" />
            ) : !data ? (
              <p className="text-xs text-red-400">Could not load status.</p>
            ) : (
              <>
                {data.error ? (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200 leading-snug">
                    {data.error}
                  </div>
                ) : null}
                <Row
                  label="PostgreSQL reachable"
                  ok={data.postgresReachable}
                  detail={data.databaseUrlHint}
                />
                <Row label="Prisma query OK" ok={data.prismaWorks} />
                <Row
                  label="DATABASE_URL configured"
                  ok={data.databaseUrlConfigured}
                  detail={data.databaseUrlHint}
                />
                <Row
                  label="NextAuth signing secret"
                  ok={data.nextAuthSecretConfigured}
                  detail={data.nextAuthUrl || undefined}
                />
                <Row
                  label="Signed-in session"
                  ok={status === 'loading' ? null : sessionActive}
                  detail={session?.user?.email || undefined}
                />
                <Row
                  label="Environment validation"
                  ok={data.health?.env?.ok ?? null}
                  detail={data.health?.env ? `missing=${data.health.env.missing.length} placeholders=${data.health.env.placeholder.length}` : undefined}
                />
                <Row
                  label="Wallet ledger health"
                  ok={data.health?.database?.wallet_ledger_ok ?? null}
                  detail={data.health?.database?.error || undefined}
                />
                {typeof data.userRowCount === 'number' ? (
                  <p className="text-[10px] text-slate-500 pt-1">
                    User rows in DB: <span className="font-mono text-slate-400">{data.userRowCount}</span>
                  </p>
                ) : null}
              </>
            )}
          </Card>
        </motion.div>

        <motion.div variants={fadeUp}>
          <Card className="p-5 space-y-2 text-[11px] text-slate-500 leading-relaxed">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Quick fixes</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>Copy the Supabase direct Postgres URI into both <span className="font-mono text-slate-400">.env.local</span> and <span className="font-mono text-slate-400">.env</span>.</li>
              <li>Run <span className="font-mono text-slate-400">npx prisma db push</span> then <span className="font-mono text-slate-400">npm run db:seed</span>.</li>
              <li>Ensure password characters are URL-encoded in the connection string.</li>
            </ul>
          </Card>
        </motion.div>
      </motion.div>
    </>
  )
}

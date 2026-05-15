'use client'
import { motion } from 'framer-motion'
import { CditPageShell } from '@/components/digital/CditPageShell'
import { PaymentStatusBadge } from '@/components/digital/PaymentProgress'
import { useCditDashboard } from '@/hooks/useDigital'
import { Card, KpiCard, Skeleton, Empty, Money, BdtText } from '@/components/ui'
import { StatusPieChart } from '@/components/charts'
import { fmt, fmtNum } from '@/lib/utils'

const fade = (i: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: i * 0.06, duration: 0.35 },
})

export default function DigitalDashboardPage() {
  const { data, loading } = useCditDashboard()
  const kpis = data?.kpis
  const statusPie = Object.entries(data?.by_status ?? {}).map(([name, value]) => ({ name, value }))
  const servicePie = Object.entries(data?.by_service ?? {}).map(([name, value]) => ({ name, value }))

  return (
    <CditPageShell title="Agency Dashboard" subtitle="Creative Digital IT · Billing & receivables">
      <motion.div {...fade(0)} className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Total receivable" value={loading ? '—' : fmt(kpis?.total_receivable ?? 0)} color="text-amber-400" loading={loading} />
        <KpiCard label="Collected (month)" value={loading ? '—' : fmt(kpis?.collected_this_month ?? 0)} color="text-emerald-400" loading={loading} />
        <KpiCard label="Unpaid invoices" value={loading ? '—' : fmtNum(kpis?.unpaid_invoices ?? 0)} loading={loading} />
        <KpiCard label="Partial projects" value={loading ? '—' : fmtNum(kpis?.partially_paid_projects ?? 0)} color="text-amber-400" loading={loading} />
        <KpiCard label="Recurring revenue" value={loading ? '—' : fmt(kpis?.recurring_revenue ?? kpis?.mrr ?? 0)} color="text-gold-lt" loading={loading} />
      </motion.div>
      <motion.div {...fade(1)} className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Clients" value={loading ? '—' : fmtNum(kpis?.total_clients ?? 0)} loading={loading} />
        <KpiCard label="Active Projects" value={loading ? '—' : fmtNum(kpis?.active_projects ?? 0)} color="text-blue-400" loading={loading} />
        <KpiCard label="Revenue" value={loading ? '—' : fmt(kpis?.total_revenue ?? 0)} loading={loading} />
        <KpiCard label="Net Profit" value={loading ? '—' : fmt(kpis?.net_profit ?? 0)} color="text-green-400" loading={loading} />
      </motion.div>
      <motion.div {...fade(2)} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-4">Project Status</p>
          {loading ? <Skeleton className="h-40" /> : statusPie.length === 0 ? (
            <Empty icon="◰" title="No projects yet" desc="Create a project to see status breakdown" />
          ) : <StatusPieChart data={statusPie} />}
        </Card>
        <Card className="p-5">
          <p className="text-sm font-bold text-cream mb-4">Services Mix</p>
          {loading ? <Skeleton className="h-40" /> : servicePie.length === 0 ? (
            <Empty icon="◧" title="No service data" desc="Projects will populate this chart" />
          ) : <StatusPieChart data={servicePie} />}
        </Card>
      </motion.div>
      {(data?.partial_projects ?? []).length > 0 && (
        <motion.div {...fade(3)}>
          <Card className="p-5">
            <p className="text-sm font-bold text-cream mb-4">Partially paid projects</p>
            <div className="space-y-3">
              {(data?.partial_projects ?? []).map(pr => (
                <div key={pr.id} className="flex items-center gap-3 flex-wrap border-b border-border/50 pb-3 last:border-0">
                  <span className="font-mono text-[10px] text-gold">{pr.id}</span>
                  <span className="flex-1 text-xs text-cream truncate">{pr.project_name || pr.title}</span>
                  <PaymentStatusBadge status={pr.payment_status} />
                  <span className="text-xs text-amber-400">Due <Money amount={pr.due_amount} /></span>
                </div>
              ))}
            </div>
          </Card>
        </motion.div>
      )}
      <motion.div {...fade(4)}>
        <Card className="p-5 overflow-hidden">
          <p className="text-sm font-bold text-cream mb-4">Recent Invoices</p>
          <div className="divide-y divide-border">
            {loading ? (
              <div className="p-4"><Skeleton className="h-24" /></div>
            ) : (data?.recent_invoices ?? []).length === 0 ? (
              <div className="p-6"><Empty icon="◈" title="No invoices" desc="Create your first agency invoice" /></div>
            ) : (
              (data?.recent_invoices ?? []).map(inv => (
                <div key={inv.id} className="px-4 py-3 flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-[11px] text-gold font-bold">{inv.id}</span>
                  <span className="flex-1 text-xs text-cream truncate">{inv.client_name}</span>
                  <PaymentStatusBadge status={inv.payment_status} />
                  <span className="text-xs text-zinc-500">Due <Money amount={inv.due_amount ?? 0} /></span>
                  <span className="text-xs font-bold text-cream"><Money amount={inv.amount} /></span>
                </div>
              ))
            )}
          </div>
        </Card>
      </motion.div>
    </CditPageShell>
  )
}

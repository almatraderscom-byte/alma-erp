'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { PageHeader, Card, Skeleton, Empty, Button } from '@/components/ui'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const fadeUp = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } }

export default function AuditLogPage() {
  const [rows, setRows] = useState<
    Array<{
      timestamp: string
      route: string
      actor: string
      actor_role: string
      business_id: string
      entity_type: string
      entity_id: string
      summary: string
      status_flag: string
    }>
  >([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const res = await api.audit.list({ limit: '300' })
      setRows(res.audit || [])
    } catch (e) {
      const msg = e instanceof APIError ? e.userMessage : (e as Error).message
      toast.error(msg)
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Recent mutations from Apps Script with Supabase fallback."
        actions={<Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading}>Refresh</Button>}
      />
      <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0 max-w-full px-3 py-4 pb-24 sm:px-6 md:pb-6">
        <motion.div variants={fadeUp}>
          <Card className="overflow-hidden">
            {loading ? (
              <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
            ) : rows.length === 0 ? (
              <div className="p-10"><Empty icon="◇" title="No entries" desc="Perform writes while Session is set — rows appear after GAS records them." /></div>
            ) : (
              <div className="overflow-x-auto min-w-0 max-w-full table-scroll max-h-[min(70vh,560px)]">
                <table className="w-full min-w-[960px] text-left text-[10px]">
                  <thead className="sticky top-0 bg-white border-b border-border z-[1]">
                    <tr className="text-slate-400 uppercase tracking-wider">
                      <th className="py-2 px-3">Time</th>
                      <th className="py-2 px-3">Action</th>
                      <th className="py-2 px-3">Actor</th>
                      <th className="py-2 px-3">Role</th>
                      <th className="py-2 px-3">Business</th>
                      <th className="py-2 px-3">Status</th>
                      <th className="py-2 px-3">Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.timestamp}-${r.route}-${i}`} className="border-b border-black/[0.04] hover:bg-slate-50/50 transition-colors">
                        <td className="py-2 px-3 font-mono text-slate-400 whitespace-nowrap">{r.timestamp}</td>
                        <td className="py-2 px-3 font-mono text-gold">{r.route}</td>
                        <td className="py-2 px-3 text-slate-800">{r.actor}</td>
                        <td className="py-2 px-3 text-slate-500">{r.actor_role}</td>
                        <td className="py-2 px-3 text-slate-500">{r.business_id}</td>
                        <td className="py-2 px-3">
                          <span className={r.status_flag === 'FAIL' ? 'text-red-500' : 'text-emerald-600'}>{r.status_flag}</span>
                        </td>
                        <td className="py-2 px-3 text-slate-400 max-w-[280px] truncate" title={r.summary}>{r.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </motion.div>
      </motion.div>
    </>
  )
}

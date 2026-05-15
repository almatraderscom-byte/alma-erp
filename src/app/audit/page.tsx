'use client'
import { useEffect, useState } from 'react'
import { PageHeader, Card, Skeleton, Empty, Button } from '@/components/ui'
import { api, APIError } from '@/lib/api'
import toast from 'react-hot-toast'

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
        subtitle="Recent mutations forwarded from Apps Script (success and failure rows)."
        actions={<Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading}>Refresh</Button>}
      />
      <div className="p-4 md:p-6 pb-24 md:pb-6">
        <Card className="overflow-hidden">
          {loading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          ) : rows.length === 0 ? (
            <div className="p-10"><Empty icon="◇" title="No entries" desc="Perform writes while Session is set — rows appear after GAS records them." /></div>
          ) : (
            <div className="overflow-x-auto max-h-[min(70vh,560px)] overflow-y-auto scrollbar-hide">
              <table className="w-full text-left text-[10px]">
                <thead className="sticky top-0 bg-card border-b border-border z-[1]">
                  <tr className="text-zinc-500 uppercase tracking-wider">
                    <th className="py-2 px-3">Time</th>
                    <th className="py-2 px-3">Route</th>
                    <th className="py-2 px-3">Actor</th>
                    <th className="py-2 px-3">Role</th>
                    <th className="py-2 px-3">Business</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.timestamp}-${r.route}-${i}`} className="border-b border-border/50 hover:bg-white/[0.02]">
                      <td className="py-2 px-3 font-mono text-zinc-400 whitespace-nowrap">{r.timestamp}</td>
                      <td className="py-2 px-3 font-mono text-gold-lt">{r.route}</td>
                      <td className="py-2 px-3 text-cream">{r.actor}</td>
                      <td className="py-2 px-3 text-zinc-500">{r.actor_role}</td>
                      <td className="py-2 px-3 text-zinc-500">{r.business_id}</td>
                      <td className="py-2 px-3">
                        <span className={r.status_flag === 'FAIL' ? 'text-red-400' : 'text-emerald-400'}>{r.status_flag}</span>
                      </td>
                      <td className="py-2 px-3 text-zinc-400 max-w-[280px] truncate" title={r.summary}>{r.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

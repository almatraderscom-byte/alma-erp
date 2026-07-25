'use client'

/**
 * Every settings change, newest first, with the value it replaced and a way to put it back.
 *
 * Roadmap §3.4. A phone system that silently changed under you is exactly how a whole day
 * disappears — and this one has form: a `noload` line in the wrong section left the softphone
 * dead for hours, and nothing on any screen said anything had been touched.
 *
 * Only the newest change per setting can be reverted. Putting back a value that something
 * newer has already replaced would quietly undo the newer change too, which is the same class
 * of surprise this page exists to remove.
 */

import { useCallback, useState } from 'react'
import type { HistoryRow } from '@/agent/lib/phone-settings-types'
import { useJson } from './useJson'
import { EmptyState, ErrorNote, PageHead, Panel, TableWrap, Td, Th } from './ui'

const ENDPOINT = '/api/assistant/phone-console/settings/history'

export function SettingsHistoryView() {
  const { data, error, loading, reload } = useJson<{ history: HistoryRow[] }>(ENDPOINT)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const revert = useCallback(async (id: string) => {
    setBusy(id)
    setProblem(null)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) { setProblem(body.error ?? `HTTP ${res.status}`); return }
      reload()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [reload])

  const rows = data?.history ?? []

  return (
    <>
      <PageHead title="পরিবর্তনের ইতিহাস" subtitle="কে, কখন, কী থেকে কী করেছে — আর এক ক্লিকে ফেরত।" />

      {error && <div className="mb-3"><ErrorNote>{error}</ErrorNote></div>}
      {problem && <div className="mb-3"><ErrorNote>{problem}</ErrorNote></div>}

      <Panel>
        {loading && !data && <EmptyState>আনা হচ্ছে…</EmptyState>}
        {data && rows.length === 0 && <EmptyState>এখনো কোনো সেটিং বদলানো হয়নি।</EmptyState>}

        {rows.length > 0 && (
          <TableWrap>
            <thead>
              <tr><Th>কখন</Th><Th>কী</Th><Th>আগে</Th><Th>এখন</Th><Th>কে</Th><Th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-muted">
                    {new Date(r.at).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  </Td>
                  <Td>{r.label}</Td>
                  <Td className="text-muted">{r.from || <span className="opacity-60">খালি ছিল</span>}</Td>
                  <Td className="font-medium">{r.to || <span className="opacity-60">খালি</span>}</Td>
                  <Td className="text-muted">{r.actor}</Td>
                  <Td>
                    {r.revertable ? (
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => void revert(r.id)}
                        className="rounded-full border border-border-subtle px-3 py-1 text-[11px] text-muted transition-colors hover:border-[#E07A5F]/40 hover:text-cream disabled:opacity-50"
                      >
                        {busy === r.id ? 'ফেরাচ্ছি…' : 'ফেরত নাও'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted opacity-60" title="এরপর আবার বদলানো হয়েছে">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Panel>
    </>
  )
}

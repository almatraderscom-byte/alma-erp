/**
 * GET /api/assistant/phone-console/calls — the call log, filtered and paged.
 *
 * Owner-only and read-only: history, hangup causes, audio counters and a freshly signed
 * recording link per call. The stored recording URL is signed and expires, so it is re-signed
 * here rather than handed over dead.
 *
 * `format=csv` returns the same rows as a spreadsheet, because "send me last month's calls"
 * should not need an engineer either.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { listCalls, periodDays, type CallLogFilters } from '@/agent/lib/phone-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 })
  if (!isSystemOwner(session)) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const q = new URL(req.url).searchParams
  const direction = q.get('direction')
  const status = q.get('status')
  const csv = q.get('format') === 'csv'
  const filters: CallLogFilters = {
    days: periodDays(q.get('period')),
    // One export, not one page of it: an export that silently stopped at 25 rows would be
    // worse than no export at all.
    perPage: csv ? 200 : Number(q.get('perPage') ?? 25) || 25,
    page: csv ? 1 : Number(q.get('page') ?? 1) || 1,
    direction: direction === 'inbound' || direction === 'outbound' ? direction : 'all',
    status: status === 'answered' || status === 'unreached' || status === 'recorded' ? status : 'all',
    number: q.get('number') ?? undefined,
  }

  try {
    const page = await listCalls(filters)
    if (!csv) return NextResponse.json({ ok: true, ...page, filters })

    const header = ['ধরন', 'নম্বর', 'নাম', 'শুরু', 'দৈর্ঘ্য (সে)', 'অবস্থা', 'কেন কাটল', 'কোড', 'ট্রান্সফার', 'রেকর্ডিং', 'কেটেছে', 'ফ্রেম বাদ']
    const lines = [header.join(',')]
    for (const c of page.calls) {
      lines.push([
        c.direction === 'inbound' ? 'ইনকামিং' : c.direction === 'outbound' ? 'আউটগোয়িং' : '—',
        c.number, c.name ?? '', c.startedAt ?? '', c.durationSecs ?? '',
        c.statusLabel, c.hangupCauseLabel ?? c.hangupCauseTxt ?? '', c.hangupCause ?? '',
        c.transferredTo ?? '', c.recordingUrl ? 'আছে' : '',
        c.audio?.underruns ?? '', c.audio?.dropped ?? '',
      ].map(csvCell).join(','))
    }
    // The BOM is what makes Excel open Bangla as Bangla instead of mojibake.
    return new NextResponse(`﻿${lines.join('\n')}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="alma-call-log.csv"`,
      },
    })
  } catch (err) {
    console.warn('[phone-console/calls] failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: 'query_failed' }, { status: 500 })
  }
}

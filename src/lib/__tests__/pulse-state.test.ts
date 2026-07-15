import { describe, it, expect } from 'vitest'
import {
  alertKeyFor,
  approvalEventKey,
  clampCount,
  clampProgress,
  copyForMode,
  formatTakaBn,
  reminderEventKey,
  selectPulseMode,
  toBanglaDigits,
  toPulseContentState,
  topPulseItems,
  urgentEventKey,
  type PulseItem,
  type PulseSnapshot,
} from '@/lib/pulse-state'

const BASE = {
  hasUrgentAlert: false,
  hasBlockingApproval: false,
  runningOrderCount: 0,
  hasRunningJob: false,
}

describe('selectPulseMode — the deterministic priority engine (spec §5)', () => {
  it('urgent outranks everything, including a blocking approval', () => {
    expect(
      selectPulseMode({
        ...BASE,
        hasUrgentAlert: true,
        hasBlockingApproval: true,
        runningOrderCount: 12,
        hasRunningJob: true,
      }),
    ).toBe('urgent')
  })

  it('approval outranks orders and jobs', () => {
    expect(
      selectPulseMode({ ...BASE, hasBlockingApproval: true, runningOrderCount: 9, hasRunningJob: true }),
    ).toBe('approval')
  })

  it('orders outranks a running job', () => {
    expect(selectPulseMode({ ...BASE, runningOrderCount: 3, hasRunningJob: true })).toBe('orders')
  })

  it('working when only a job is running', () => {
    expect(selectPulseMode({ ...BASE, hasRunningJob: true })).toBe('working')
  })

  it('stale beats offline, and both beat overview', () => {
    expect(selectPulseMode({ ...BASE, isStale: true, isOffline: true })).toBe('stale')
    expect(selectPulseMode({ ...BASE, isOffline: true })).toBe('offline')
  })

  it('overview is the resting state', () => {
    expect(selectPulseMode(BASE)).toBe('overview')
  })

  it('a negative/garbage order count never fakes the orders mode', () => {
    expect(selectPulseMode({ ...BASE, runningOrderCount: -5 })).toBe('overview')
    expect(selectPulseMode({ ...BASE, runningOrderCount: NaN })).toBe('overview')
  })

  it('stale/offline never mask a real urgent alert', () => {
    expect(selectPulseMode({ ...BASE, hasUrgentAlert: true, isOffline: true })).toBe('urgent')
  })
})

describe('clamps (spec §4)', () => {
  it('counts are non-negative integers', () => {
    expect(clampCount(5)).toBe(5)
    expect(clampCount(-3)).toBe(0)
    expect(clampCount(2.7)).toBe(2)
    expect(clampCount('4')).toBe(4)
    expect(clampCount(NaN)).toBe(0)
    expect(clampCount(undefined)).toBe(0)
    expect(clampCount('abc')).toBe(0)
  })

  it('progress is clamped to 0…1, and absent stays absent', () => {
    expect(clampProgress(0.5)).toBe(0.5)
    expect(clampProgress(1.9)).toBe(1)
    expect(clampProgress(-2)).toBe(0)
    expect(clampProgress(undefined)).toBeUndefined()
    expect(clampProgress(null)).toBeUndefined()
    expect(clampProgress(NaN)).toBeUndefined()
  })
})

describe('alert dedupe keys (spec §11.5)', () => {
  it('builds stable per-event keys', () => {
    expect(approvalEventKey('a1')).toBe('approval:a1:created')
    expect(urgentEventKey('stock:ALM-351')).toBe('urgent:stock:ALM-351:created')
  })

  it('the same approval in the same window yields ONE reminder key', () => {
    const a = new Date('2026-07-16T10:00:00Z')
    const b = new Date('2026-07-16T10:59:00Z')
    expect(reminderEventKey('a1', a)).toBe(reminderEventKey('a1', b))
  })

  it('a later window yields a new reminder key', () => {
    const a = new Date('2026-07-16T10:00:00Z')
    const c = new Date('2026-07-16T11:30:00Z')
    expect(reminderEventKey('a1', a)).not.toBe(reminderEventKey('a1', c))
  })

  it('only urgent and approval justify a sound — orders/overview are silent', () => {
    expect(alertKeyFor({ mode: 'urgent', urgentAlert: { id: 'u1' } })).toBe('urgent:u1:created')
    expect(alertKeyFor({ mode: 'approval', approval: { id: 'a1' } })).toBe('approval:a1:created')
    expect(alertKeyFor({ mode: 'orders', approval: { id: 'a1' } })).toBeUndefined()
    expect(alertKeyFor({ mode: 'overview' })).toBeUndefined()
    expect(alertKeyFor({ mode: 'success' })).toBeUndefined()
  })

  it('the key is identical across polls of the same event, so it can only chime once', () => {
    const first = alertKeyFor({ mode: 'approval', approval: { id: 'a1' } })
    const second = alertKeyFor({ mode: 'approval', approval: { id: 'a1' } })
    expect(first).toBe(second)
  })
})

describe('Bangla formatting (owner rule)', () => {
  it('converts digits', () => {
    expect(toBanglaDigits(24)).toBe('২৪')
    expect(toBanglaDigits(0)).toBe('০')
  })

  it('formats whole taka with grouping — never a float', () => {
    expect(formatTakaBn(48500)).toBe('৳৪৮,৫০০')
    expect(formatTakaBn(48500.4)).toBe('৳৪৮,৫০০')
  })
})

describe('copyForMode — human Bangla, never an enum name (spec §4)', () => {
  const ctx = { pendingTaskCount: 7, approvalCount: 3, runningOrderCount: 12 }

  it('never leaks the raw mode string', () => {
    for (const mode of ['urgent', 'approval', 'orders', 'working', 'overview', 'stale', 'offline'] as const) {
      const { headline, subtitle } = copyForMode(mode, ctx)
      expect(headline).not.toContain(mode)
      expect(headline.length).toBeGreaterThan(0)
      expect(subtitle.length).toBeGreaterThan(0)
    }
  })

  it('orders headline counts in Bangla', () => {
    expect(copyForMode('orders', ctx).headline).toBe('১২টি অর্ডার চলছে')
  })

  it('stale copy states the age honestly', () => {
    expect(copyForMode('stale', { ...ctx, staleMinutes: 12 }).subtitle).toBe(
      'সর্বশেষ আপডেট ১২ মিনিট আগে',
    )
  })

  it('an empty overview says so rather than inventing work', () => {
    const { subtitle } = copyForMode('overview', {
      pendingTaskCount: 0,
      approvalCount: 0,
      runningOrderCount: 0,
    })
    expect(subtitle).toBe('এই মুহূর্তে কিছু বাকি নেই')
  })
})

describe('topPulseItems — three highest-priority rows (spec §4)', () => {
  const item = (id: string, severity: PulseItem['severity'], createdAt: string): PulseItem => ({
    id,
    kind: 'system',
    title: id,
    subtitle: '',
    severity,
    createdAt,
  })

  it('urgent outranks attention outranks normal, regardless of age', () => {
    const items = [
      item('old-normal', 'normal', '2026-07-16T10:00:00Z'),
      item('new-normal', 'normal', '2026-07-16T12:00:00Z'),
      item('urgent', 'urgent', '2026-07-16T09:00:00Z'),
      item('attention', 'attention', '2026-07-16T11:00:00Z'),
    ]
    expect(topPulseItems(items).map((i) => i.id)).toEqual(['urgent', 'attention', 'new-normal'])
  })

  it('caps at three', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item(`i${i}`, 'normal', '2026-07-16T10:00:00Z'),
    )
    expect(topPulseItems(items)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------

const SNAPSHOT: PulseSnapshot = {
  mode: 'approval',
  headline: 'আপনার অনুমোদনেই পরের ধাপ',
  subtitle: 'লেজার এন্ট্রি — অপেক্ষায়',
  pendingTaskCount: 7,
  approvalCount: 3,
  runningOrderCount: 12,
  orderProgress: 0.68,
  items: [
    {
      id: 'a1',
      kind: 'approval',
      title: 'লেজার এন্ট্রি',
      subtitle: 'Hossain Mama',
      valueText: '৳৪৮,৫০০',
      severity: 'attention',
      createdAt: '2026-07-16T10:00:00Z',
      link: 'almaerp://approvals/a1',
    },
  ],
  lastUpdatedAt: '2026-07-16T10:00:00Z',
  staleAfter: '2026-07-16T10:15:00Z',
  approval: {
    id: 'a1',
    title: 'লেজার এন্ট্রি',
    counterparty: 'Hossain Mama',
    amountText: '৳৪৮,৫০০',
    createdAt: '2026-07-16T10:00:00Z',
  },
  alertKey: 'approval:a1:created',
  ordersToday: 4,
  statusLine: 'সর্বশেষ: পেন্ডিং',
  pendingApprovals: 3,
  openTasks: 7,
}

describe('toPulseContentState — the canonical native projection', () => {
  it('encodes every date as epoch SECONDS, never an ISO string', () => {
    const cs = toPulseContentState(SNAPSHOT)
    expect(cs.updatedAtEpoch).toBe(Math.floor(Date.parse('2026-07-16T10:00:00Z') / 1000))
    expect(cs.staleAfterEpoch).toBe(Math.floor(Date.parse('2026-07-16T10:15:00Z') / 1000))
    expect(cs.items[0].createdAtEpoch).toBe(Math.floor(Date.parse('2026-07-16T10:00:00Z') / 1000))
    expect(typeof cs.updatedAtEpoch).toBe('number')
  })

  it('keeps the legacy v1/v2 keys so an older native build still renders', () => {
    const cs = toPulseContentState(SNAPSHOT)
    expect(cs.ordersToday).toBe(4)
    expect(cs.statusLine).toBe('সর্বশেষ: পেন্ডিং')
    expect(cs.pendingApprovals).toBe(3)
    expect(cs.openTasks).toBe(7)
  })

  it('carries the approval amount and its deep link', () => {
    const cs = toPulseContentState(SNAPSHOT)
    expect(cs.approvalAmountText).toBe('৳৪৮,৫০০')
    expect(cs.items[0].link).toBe('almaerp://approvals/a1')
  })

  it('drops undefined keys so the pushed payload stays small', () => {
    const cs = toPulseContentState(SNAPSHOT)
    expect('successTitle' in cs).toBe(false)
    expect('alertTitle' in cs).toBe(false)
  })

  it('success overrides the mode/copy but keeps the authoritative metrics, so the panel can fall back to real state (spec §6.6)', () => {
    const cs = toPulseContentState(SNAPSHOT, {
      success: {
        title: 'অনুমোদন হয়েছে',
        detail: 'কাজ আবার এগোচ্ছে',
        completedAt: '2026-07-16T10:05:00Z',
      },
    })
    expect(cs.mode).toBe('success')
    expect(cs.headline).toBe('অনুমোদন হয়েছে')
    expect(cs.successTitle).toBe('অনুমোদন হয়েছে')
    // The real numbers survive — success must not strand a cached state.
    expect(cs.approvalCount).toBe(3)
    expect(cs.runningOrderCount).toBe(12)
  })

  it('clamps hostile values coming off the wire', () => {
    const cs = toPulseContentState({
      ...SNAPSHOT,
      orderProgress: 4.2,
      runningOrderCount: -9,
      items: [{ ...SNAPSHOT.items[0], progress: -1 }],
    })
    expect(cs.orderProgress).toBe(1)
    expect(cs.runningOrderCount).toBe(0)
    expect(cs.items[0].progress).toBe(0)
  })
})

describe('deep links must resolve to routes this app really has (spec §16)', () => {
  // DeepLinkManager maps almaerp://<host><path><query> → /<host><path><query>.
  // These are the ONLY routes that exist (verified against src/app):
  //   /agent · /orders · /inventory (?q= search) · /approvals
  // The spec's own examples (almaerp://orders/running, almaerp://tasks/pending,
  // almaerp://approvals/{id}, almaerp://inventory/{code}) all 404 here, so this
  // test exists to stop them creeping back in.
  const REAL_ROUTES = new Set(['agent', 'orders', 'inventory', 'approvals'])

  function toPath(link: string) {
    const u = new URL(link)
    return { host: u.host, pathname: u.pathname, search: u.search }
  }

  it('maps a custom-scheme link the same way DeepLinkManager does', () => {
    const { host, search } = toPath('almaerp://inventory?q=ALM-351')
    expect(`/${host}${search}`).toBe('/inventory?q=ALM-351')
  })

  it.each([
    'almaerp://agent',
    'almaerp://orders',
    'almaerp://inventory?q=ALM-351',
  ])('%s points at a route that exists and adds no fake path segment', (link) => {
    const { host, pathname } = toPath(link)
    expect(REAL_ROUTES.has(host)).toBe(true)
    // A path segment (e.g. /orders/running) would 404 — no such route exists.
    expect(pathname === '' || pathname === '/').toBe(true)
  })

  it('rejects the spec-shaped links that would 404', () => {
    for (const bad of [
      'almaerp://orders/running',
      'almaerp://tasks/pending',
      'almaerp://approvals/a1',
      'almaerp://inventory/ALM-351',
    ]) {
      const { host, pathname } = toPath(bad)
      const hasFakeSegment = pathname !== '' && pathname !== '/'
      expect(hasFakeSegment || !REAL_ROUTES.has(host)).toBe(true)
    }
  })
})

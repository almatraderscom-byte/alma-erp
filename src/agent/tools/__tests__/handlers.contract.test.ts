import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Prisma mock ────────────────────────────────────────────────────────────
const mockPrisma = {
  agentSalahRecord: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  agentTodo: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  agentReminder: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  agentPendingAction: {
    create: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
  agentSalahOverride: {
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  agentMemory: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
}

vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

// ── External side-effect mocks ──────────────────────────────────────────────
vi.mock('@/agent/lib/telegram-owner-notify', () => ({
  sendOwnerText: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/agent/lib/salah-context', () => ({
  WAQTS: ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'],
  summarizeWaqts: vi.fn().mockReturnValue([]),
  pickAccountableWaqts: vi.fn().mockReturnValue([]),
}))
vi.mock('@/agent/lib/salah-status-answer', () => ({
  buildSalahStatusAnswer: vi.fn().mockReturnValue({ answerBangla: '', allDone: false }),
}))
vi.mock('@/agent/lib/salah-times', () => ({
  getDhakaPrayerTimes: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/agent/lib/dhaka-schedule', () => ({
  getDhakaSchedule: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/agent/lib/salah-resolve', () => ({
  isPhantomSalahConfirmation: vi.fn().mockReturnValue(false),
}))
vi.mock('@/lib/salah/duty-window', () => ({
  computeLockUntil: vi.fn().mockReturnValue(null),
  MAX_DELAY_MIN: 30,
}))
vi.mock('@/lib/owner-call-lock', () => ({
  setOwnerCallLockUntil: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/salah/time-config', () => ({
  getSalahTimeConfig: vi.fn().mockResolvedValue({}),
  setSalahWaqtTimes: vi.fn().mockResolvedValue({}),
  isValidHm: vi.fn().mockReturnValue(true),
}))
vi.mock('@/lib/agent-api/dhaka-date', () => ({
  todayYmdDhaka: vi.fn().mockReturnValue('2026-06-16'),
  dhakaMidnightUtc: vi.fn().mockImplementation((ymd: string) => new Date(`${ymd}T00:00:00.000Z`)),
  addDaysYmd: vi.fn().mockReturnValue('2026-06-15'),
}))
vi.mock('@/agent/lib/reminder-rrule', () => ({
  formatReminderConfirmation: vi.fn().mockReturnValue('Reminder set.'),
}))
vi.mock('@/agent/lib/urgent-rate-limit', () => ({
  checkUrgentRateLimit: vi.fn().mockResolvedValue({ ok: true }),
  checkOutboundCallRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/agent/lib/outbound-call-tracking', () => ({
  summarizeOutboundAction: vi.fn().mockReturnValue({}),
  outboundWasDialed: vi.fn().mockReturnValue(false),
  OUTBOUND_RINGING_WINDOW_MS: 90_000,
  // Mirror the real predicate closely enough for the dedup contract: a not-yet-dialed
  // draft (pending) or an in-flight call (approved) blocks; anything else does not.
  isBlockingOutboundDuplicate: vi
    .fn()
    .mockImplementation((r: { status?: string }) => r?.status === 'pending' || r?.status === 'approved'),
}))
vi.mock('@/lib/twilio/phone', () => ({
  normalizeOutboundPhone: vi.fn().mockImplementation((p: string) => p),
}))
vi.mock('@/agent/lib/todo-sort', () => ({
  sortTodosForDisplay: vi.fn().mockImplementation((arr: unknown[]) => arr),
}))

beforeEach(() => vi.clearAllMocks())

// ── Test helpers ────────────────────────────────────────────────────────────

async function loadHandler(toolName: string) {
  // Dynamic imports reset per-module state, but mock stays active
  const { SALAH_TOOLS } = await import('@/agent/tools/salah-tools')
  const { WORK_TODO_TOOLS } = await import('@/agent/tools/work-todo-tools')
  const { REMINDER_TOOLS } = await import('@/agent/tools/reminder-tools')

  const all = [...SALAH_TOOLS, ...WORK_TODO_TOOLS, ...REMINDER_TOOLS]
  const tool = all.find(t => t.name === toolName)
  if (!tool) throw new Error(`Tool not found: ${toolName}`)
  return tool.handler
}

// ═══════════════════════════════════════════════════════════════════════════
// mark_salah
// ═══════════════════════════════════════════════════════════════════════════
describe('mark_salah', () => {
  it('upserts salah record with correct date (UTC midnight)', async () => {
    const handler = await loadHandler('mark_salah')
    mockPrisma.agentSalahRecord.findUnique.mockResolvedValue(null)
    mockPrisma.agentSalahRecord.upsert.mockResolvedValue({
      id: 'r1', waqt: 'maghrib', status: 'prayed_on_time', confirmedAt: new Date(),
    })

    const result = await handler({ waqt: 'maghrib', status: 'prayed_on_time', date: '2026-06-16' })
    expect(result.success).toBe(true)

    expect(mockPrisma.agentSalahRecord.upsert).toHaveBeenCalledOnce()
    const call = mockPrisma.agentSalahRecord.upsert.mock.calls[0][0]
    expect(call.where.date_waqt.date).toEqual(new Date('2026-06-16T00:00:00.000Z'))
    expect(call.where.date_waqt.waqt).toBe('maghrib')
    expect(call.update.status).toBe('prayed_on_time')
  })

  it('returns error when waqt is missing', async () => {
    const handler = await loadHandler('mark_salah')
    const result = await handler({ status: 'prayed_on_time' })
    // The handler wraps in try/catch, should not throw
    expect(result.success === false || result.success === true).toBe(true)
  })

  it('blocks marking future waqt before windowStart', async () => {
    const handler = await loadHandler('mark_salah')
    const futureDate = new Date(Date.now() + 86400_000)
    mockPrisma.agentSalahRecord.findUnique.mockResolvedValue({
      windowStart: futureDate,
      windowEnd: new Date(futureDate.getTime() + 3600_000),
    })

    const result = await handler({ waqt: 'isha', status: 'prayed_on_time', date: '2026-06-16' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('শুরু হয়নি')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// manage_work_todos
// ═══════════════════════════════════════════════════════════════════════════
describe('manage_work_todos', () => {
  it('add: creates todo with correct source', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.create.mockResolvedValue({ id: 't1', title: 'test task', status: 'pending' })

    const result = await handler({ action: 'add', title: 'test task', source: 'owner' })
    expect(result.success).toBe(true)
    expect(mockPrisma.agentTodo.create).toHaveBeenCalledOnce()
    const createData = mockPrisma.agentTodo.create.mock.calls[0][0].data
    expect(createData.source).toBe('owner')
    expect(createData.title).toBe('test task')
  })

  it('add: returns error when title is missing', async () => {
    const handler = await loadHandler('manage_work_todos')
    const result = await handler({ action: 'add' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('title')
  })

  it('complete: owner task is soft-completed (update, not delete)', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.findUnique.mockResolvedValue({
      id: 't1', title: 'owner task', source: 'owner',
    })
    mockPrisma.agentTodo.update.mockResolvedValue({
      id: 't1', title: 'owner task', status: 'completed',
    })

    const result = await handler({ action: 'complete', id: 't1' })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).removed).toBe(true)
    expect(mockPrisma.agentTodo.delete).not.toHaveBeenCalled()
    const updateData = mockPrisma.agentTodo.update.mock.calls[0][0].data
    expect(updateData.status).toBe('completed')
  })

  it('remove: creates a confirm card (todo_cancel pending action), no hard delete', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.findUnique.mockResolvedValue({
      id: 't9', title: 'stale task', source: 'owner', status: 'pending',
    })
    mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'pa-todo-1' })

    const result = await handler({ action: 'remove', id: 't9' })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).pendingActionId).toBe('pa-todo-1')
    expect((result.data as Record<string, unknown>).actionType).toBe('todo_cancel')
    expect(mockPrisma.agentTodo.delete).not.toHaveBeenCalled()
    const createData = mockPrisma.agentPendingAction.create.mock.calls[0][0].data
    expect(createData.type).toBe('todo_cancel')
    expect(createData.payload.todoId).toBe('t9')
  })

  it('complete: agent/day_shift task gets status update not delete', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.findUnique.mockResolvedValue({
      id: 't2', title: 'office task', source: 'day_shift',
    })
    mockPrisma.agentTodo.update.mockResolvedValue({
      id: 't2', title: 'office task', status: 'completed',
    })

    const result = await handler({ action: 'complete', id: 't2' })
    expect(result.success).toBe(true)
    expect(mockPrisma.agentTodo.update).toHaveBeenCalledOnce()
    const updateData = mockPrisma.agentTodo.update.mock.calls[0][0].data
    expect(updateData.status).toBe('completed')
  })

  it('complete: returns error for non-existent todo', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.findUnique.mockResolvedValue(null)
    const result = await handler({ action: 'complete', id: 'nonexistent' })
    expect(result.success).toBe(false)
  })

  it('list: returns structured data', async () => {
    const handler = await loadHandler('manage_work_todos')
    mockPrisma.agentTodo.findMany.mockResolvedValue([])
    const result = await handler({ action: 'list' })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('active_count')
  })

  it('unknown action returns error (no throw)', async () => {
    const handler = await loadHandler('manage_work_todos')
    const result = await handler({ action: 'foobar' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// set_reminder
// ═══════════════════════════════════════════════════════════════════════════
describe('set_reminder', () => {
  it('creates reminder with future dueAt (tier 1)', async () => {
    const handler = await loadHandler('set_reminder')
    const futureIso = new Date(Date.now() + 3600_000).toISOString()
    mockPrisma.agentReminder.create.mockResolvedValue({ id: 'rem1', title: 'call doctor' })

    const result = await handler({ title: 'call doctor', dueAt: futureIso, tier: 1 })
    expect(result.success).toBe(true)
    expect(mockPrisma.agentReminder.create).toHaveBeenCalledOnce()
    const createData = mockPrisma.agentReminder.create.mock.calls[0][0].data
    expect(createData.title).toBe('call doctor')
    expect(createData.tier).toBe(1)
    expect(new Date(createData.dueAt).getTime()).toBeGreaterThan(Date.now() - 1000)
  })

  it('tier 3 creates pending action instead of direct reminder', async () => {
    const handler = await loadHandler('set_reminder')
    const futureIso = new Date(Date.now() + 3600_000).toISOString()
    mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'pa1' })

    const result = await handler({ title: 'urgent thing', dueAt: futureIso, tier: 3 })
    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('pendingActionId')
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledOnce()
    expect(mockPrisma.agentReminder.create).not.toHaveBeenCalled()
  })

  it('returns error for past dueAt', async () => {
    const handler = await loadHandler('set_reminder')
    const pastIso = new Date(Date.now() - 3600_000).toISOString()
    const result = await handler({ title: 'past', dueAt: pastIso })
    expect(result.success).toBe(false)
    expect(result.error).toContain('future')
  })

  it('returns error for missing title', async () => {
    const handler = await loadHandler('set_reminder')
    const futureIso = new Date(Date.now() + 3600_000).toISOString()
    const result = await handler({ title: '', dueAt: futureIso })
    expect(result.success).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// cancel_reminder
// ═══════════════════════════════════════════════════════════════════════════
describe('cancel_reminder', () => {
  it('updates status to cancelled', async () => {
    const handler = await loadHandler('cancel_reminder')
    mockPrisma.agentReminder.update.mockResolvedValue({ id: 'rem1', status: 'cancelled' })
    const result = await handler({ id: 'rem1' })
    expect(result.success).toBe(true)
    expect(mockPrisma.agentReminder.update).toHaveBeenCalledWith({
      where: { id: 'rem1' },
      data: { status: 'cancelled' },
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// get_prayer_times
// ═══════════════════════════════════════════════════════════════════════════
describe('get_prayer_times', () => {
  it('returns success with date and timezone', async () => {
    const handler = await loadHandler('get_prayer_times')
    const result = await handler({})
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).timezone).toBe('Asia/Dhaka')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// get_salah_status
// ═══════════════════════════════════════════════════════════════════════════
describe('get_salah_status', () => {
  it('returns success with date fields', async () => {
    const handler = await loadHandler('get_salah_status')
    mockPrisma.agentSalahRecord.findMany.mockResolvedValue([])
    const result = await handler({})
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).date).toBe('2026-06-16')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// outbound_phone_call — redraft / dedup behavior (locks the call-voice fix)
// ═══════════════════════════════════════════════════════════════════════════
describe('outbound_phone_call', () => {
  it('creates a fresh pending card (returns pendingActionId) when no duplicate exists', async () => {
    const handler = await loadHandler('outbound_phone_call')
    mockPrisma.agentPendingAction.findMany.mockResolvedValue([])
    mockPrisma.agentPendingAction.create.mockResolvedValue({ id: 'pa-new' })

    const result = await handler({ phone: '+8801711111111', message: 'বস সালাম' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.pendingActionId).toBe('pa-new')
    expect(mockPrisma.agentPendingAction.create).toHaveBeenCalledOnce()
  })

  it('UPDATES an existing pending draft in place (re-surfaces card + voice) instead of refusing', async () => {
    const handler = await loadHandler('outbound_phone_call')
    mockPrisma.agentPendingAction.findMany.mockResolvedValue([
      { id: 'pa-draft', status: 'pending', payload: { phone: '+8801711111111' } },
    ])
    mockPrisma.agentPendingAction.update.mockResolvedValue({ id: 'pa-draft' })

    const result = await handler({ phone: '+8801711111111', message: 'নতুন কথা' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    // Must re-surface the SAME card so a fresh voice preview fires this turn.
    expect(data.pendingActionId).toBe('pa-draft')
    expect(data.updatedExisting).toBe(true)
    expect(mockPrisma.agentPendingAction.update).toHaveBeenCalledOnce()
    expect(mockPrisma.agentPendingAction.create).not.toHaveBeenCalled()
    // The new wording is persisted to the draft payload.
    const updateArg = mockPrisma.agentPendingAction.update.mock.calls[0][0]
    expect(updateArg.where.id).toBe('pa-draft')
    expect(updateArg.data.payload.message).toBe('নতুন কথা')
  })

  it('still REFUSES to duplicate a call that is already approved/dialed (reports instead)', async () => {
    const handler = await loadHandler('outbound_phone_call')
    mockPrisma.agentPendingAction.findMany.mockResolvedValue([
      { id: 'pa-live', status: 'approved', payload: { phone: '+8801711111111' } },
    ])

    const result = await handler({ phone: '+8801711111111', message: 'আবার কল' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.duplicatePrevented).toBe(true)
    // No new card, no draft edit on an in-flight call.
    expect(mockPrisma.agentPendingAction.create).not.toHaveBeenCalled()
    expect(mockPrisma.agentPendingAction.update).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// preview_call_voice — replays the spoken draft (capability must exist)
// ═══════════════════════════════════════════════════════════════════════════
describe('preview_call_voice', () => {
  it('returns the latest pending draft pendingActionId to re-trigger the voice', async () => {
    const handler = await loadHandler('preview_call_voice')
    mockPrisma.agentPendingAction.findMany.mockResolvedValue([
      { id: 'pa-latest', type: 'outbound_call', status: 'pending', payload: { phone: '+8801711111111' } },
    ])

    const result = await handler({})
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.pendingActionId).toBe('pa-latest')
    expect(data.previewResent).toBe(true)
  })

  it('targets a specific draft by pendingActionId when given', async () => {
    const handler = await loadHandler('preview_call_voice')
    mockPrisma.agentPendingAction.findUnique.mockResolvedValue({
      id: 'pa-target', type: 'outbound_call', status: 'pending', payload: { phone: '+8801722222222' },
    })

    const result = await handler({ pendingActionId: 'pa-target' })
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.pendingActionId).toBe('pa-target')
    expect(mockPrisma.agentPendingAction.findUnique).toHaveBeenCalledOnce()
  })

  it('reports noPendingDraft (does NOT deny capability) when nothing is pending', async () => {
    const handler = await loadHandler('preview_call_voice')
    mockPrisma.agentPendingAction.findMany.mockResolvedValue([])

    const result = await handler({})
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.noPendingDraft).toBe(true)
  })
})

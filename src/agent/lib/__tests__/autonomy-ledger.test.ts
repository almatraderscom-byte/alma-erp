import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory KV store standing in for agent_kv_settings.
const store = vi.hoisted(() => new Map<string, string>())

const mockPrisma = vi.hoisted(() => ({
  prisma: {
    agentKvSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const v = store.get(where.key)
        return v === undefined ? null : { value: v }
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: { key: string; value: string }; update: { value: string } }) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value)
        return { key: where.key, value: store.get(where.key) }
      }),
    },
  },
}))
vi.mock('@/lib/prisma', () => mockPrisma)

// Mock the registry so undoAction's dynamic import resolves to a controllable spy.
const mockRegistry = vi.hoisted(() => ({ executeTool: vi.fn() }))
vi.mock('@/agent/tools/registry', () => mockRegistry)

// Mock notify-owner so the digest send doesn't fan out.
const mockNotify = vi.hoisted(() => ({ notifyOwner: vi.fn(async () => undefined) }))
vi.mock('@/agent/lib/notify-owner', () => mockNotify)

import {
  recordAutonomousAction,
  listRecentActions,
  getAction,
  undoAction,
  buildAutonomyDigest,
  runAutonomyDigestSend,
} from '@/agent/lib/autonomy-ledger'

beforeEach(() => {
  store.clear()
  vi.clearAllMocks()
  mockRegistry.executeTool.mockResolvedValue({ success: true })
})

describe('recordAutonomousAction + listRecentActions', () => {
  it('records an action and lists it newest-first', async () => {
    const id1 = await recordAutonomousAction({ category: 'cs_reply', summary: 'প্রথম কাজ', mode: 'auto' })
    const id2 = await recordAutonomousAction({ category: 'reorder', summary: 'দ্বিতীয় কাজ', mode: 'auto' })
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()

    const recent = await listRecentActions(10)
    expect(recent).toHaveLength(2)
    expect(recent[0].summary).toBe('দ্বিতীয় কাজ') // newest first
    expect(recent[1].summary).toBe('প্রথম কাজ')
  })

  it('getAction fetches a recorded entry by id', async () => {
    const id = await recordAutonomousAction({ category: 'cs_reply', summary: 'কাজ', mode: 'auto' })
    const e = await getAction(id!)
    expect(e?.id).toBe(id)
    expect(e?.summary).toBe('কাজ')
  })
})

describe('undoAction', () => {
  it('re-dispatches the inverse tool and marks the entry undone', async () => {
    const id = await recordAutonomousAction({
      category: 'cs_reply',
      summary: 'টুডু যোগ করেছি',
      mode: 'auto',
      undo: { tool: 'delete_owner_todo', params: { id: 't1' }, label: 'টুডুটা মুছে দাও' },
    })
    const res = await undoAction(id!)
    expect(res.ok).toBe(true)
    expect(mockRegistry.executeTool).toHaveBeenCalledWith('delete_owner_todo', { id: 't1' })

    const e = await getAction(id!)
    expect(e?.undone).toBe(true)
    expect(e?.undoneAt).toBeTruthy()
  })

  it('undo "last" picks the most-recent undo-able entry', async () => {
    await recordAutonomousAction({ category: 'cs_reply', summary: 'no undo', mode: 'auto' })
    const id = await recordAutonomousAction({
      category: 'reorder',
      summary: 'has undo',
      mode: 'auto',
      undo: { tool: 'delete_owner_todo', params: { id: 't9' }, label: 'মুছে দাও' },
    })
    const res = await undoAction('last')
    expect(res.ok).toBe(true)
    expect(res.entry?.id).toBe(id)
  })

  it('fails cleanly when the entry is not found', async () => {
    const res = await undoAction('nope')
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('not_found')
  })

  it('refuses to undo twice', async () => {
    const id = await recordAutonomousAction({
      category: 'cs_reply',
      summary: 'x',
      mode: 'auto',
      undo: { tool: 'delete_owner_todo', params: {}, label: 'মুছে' },
    })
    await undoAction(id!)
    const res = await undoAction(id!)
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('already_undone')
  })

  it('reports no_undo when the entry has no undo descriptor', async () => {
    const id = await recordAutonomousAction({ category: 'cs_reply', summary: 'x', mode: 'auto' })
    const res = await undoAction(id!)
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('no_undo_available')
  })

  it('does not mark undone when the inverse tool fails', async () => {
    mockRegistry.executeTool.mockResolvedValue({ success: false, error: 'boom' })
    const id = await recordAutonomousAction({
      category: 'cs_reply',
      summary: 'x',
      mode: 'auto',
      undo: { tool: 'delete_owner_todo', params: {}, label: 'মুছে' },
    })
    const res = await undoAction(id!)
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('undo_tool_failed')
    const e = await getAction(id!)
    expect(e?.undone).toBeFalsy()
  })
})

describe('buildAutonomyDigest', () => {
  it('returns null when nothing autonomous happened', async () => {
    const d = await buildAutonomyDigest()
    expect(d).toBeNull()
  })

  it('summarises recent actions with undo hints', async () => {
    await recordAutonomousAction({
      category: 'cs_reply',
      summary: 'কাস্টমারকে দাম জানিয়েছি',
      mode: 'auto',
      undo: { tool: 'x', params: {}, label: 'মেসেজ মুছে দাও' },
    })
    const d = await buildAutonomyDigest()
    expect(d).not.toBeNull()
    expect(d!.count).toBe(1)
    expect(d!.message).toContain('কাস্টমারকে দাম জানিয়েছি')
    expect(d!.message).toContain('মেসেজ মুছে দাও')
  })

  it('excludes already-undone actions', async () => {
    const id = await recordAutonomousAction({
      category: 'cs_reply',
      summary: 'x',
      mode: 'auto',
      undo: { tool: 'x', params: {}, label: 'মুছে' },
    })
    await undoAction(id!)
    const d = await buildAutonomyDigest()
    expect(d).toBeNull()
  })
})

describe('runAutonomyDigestSend', () => {
  it('skips when there is nothing to report', async () => {
    const r = await runAutonomyDigestSend()
    expect(r.sent).toBe(false)
    expect(r.detail).toBe('nothing_to_report')
  })

  it('sends once and dedups within the same Dhaka-day', async () => {
    await recordAutonomousAction({ category: 'cs_reply', summary: 'কাজ', mode: 'auto' })
    const now = new Date('2026-06-29T05:00:00Z')
    const first = await runAutonomyDigestSend({ now })
    expect(first.sent).toBe(true)
    expect(mockNotify.notifyOwner).toHaveBeenCalledTimes(1)

    const second = await runAutonomyDigestSend({ now })
    expect(second.sent).toBe(false)
    expect(second.detail).toBe('already_sent')
    expect(mockNotify.notifyOwner).toHaveBeenCalledTimes(1)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 5 workflow-guard tests — the moved HARD RULEs run against an in-memory
 * prisma fake so the REAL guard logic executes (blocks only on positive
 * invariant violations, always fails open).
 */

const { store, makeModel } = vi.hoisted(() => {
  type HRow = Record<string, unknown>
  const store: { workflowRun: HRow[]; workflowRunEvent: HRow[]; agentOpenTask: HRow[]; agentPendingAction: HRow[]; agentKvSetting: HRow[] } = {
    workflowRun: [], workflowRunEvent: [], agentOpenTask: [], agentPendingAction: [], agentKvSetting: [],
  }
  let idSeq = 0
  const matches = (row: HRow, where: HRow): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as HRow[]).some((clause) => matches(row, clause))
      if (v && typeof v === 'object' && 'in' in (v as HRow)) return ((v as { in: unknown[] }).in).includes(row[k])
      if (v && typeof v === 'object' && 'lt' in (v as HRow)) return row[k] != null && (row[k] as Date) < ((v as { lt: Date }).lt)
      if (v && typeof v === 'object' && 'gt' in (v as HRow)) return row[k] != null && (row[k] as Date) > ((v as { gt: Date }).gt)
      return row[k] === v
    })
  const applyData = (row: HRow, data: HRow): void => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as HRow)) {
        row[k] = ((row[k] as number) ?? 0) + ((v as { increment: number }).increment)
      } else if (v !== undefined) row[k] = v
    }
    row.updatedAt = new Date()
  }
  const stripUndefined = (o: HRow): HRow => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  const makeModel = (table: HRow[], defaults: () => HRow) => ({
    create: async ({ data }: { data: HRow }) => {
      const row: HRow = { ...defaults(), id: `id_${++idSeq}`, createdAt: new Date(), updatedAt: new Date(), ...stripUndefined(data) }
      table.push(row)
      return { ...row }
    },
    findUnique: async ({ where }: { where: HRow }) => {
      const row = table.find((r) => matches(r, where))
      return row ? { ...row } : null
    },
    findFirst: async ({ where }: { where: HRow }) => {
      const rows = table.filter((r) => matches(r, where))
      return rows[0] ? { ...rows[0] } : null
    },
    findMany: async ({ where, take }: { where?: HRow; take?: number }) => {
      let rows = where ? table.filter((r) => matches(r, where)) : [...table]
      if (take) rows = rows.slice(0, take)
      return rows.map((r) => ({ ...r }))
    },
    update: async ({ where, data }: { where: HRow; data: HRow }) => {
      const row = table.find((r) => matches(r, where))
      if (!row) throw new Error('record not found')
      applyData(row, data)
      return { ...row }
    },
    updateMany: async ({ where, data }: { where: HRow; data: HRow }) => {
      const rows = table.filter((r) => matches(r, where))
      for (const row of rows) applyData(row, data)
      return { count: rows.length }
    },
    upsert: async ({ where, update, create }: { where: HRow; update: HRow; create: HRow }) => {
      const row = table.find((r) => matches(r, where))
      if (row) { applyData(row, update); return { ...row } }
      const created: HRow = { ...stripUndefined(create), createdAt: new Date(), updatedAt: new Date() }
      table.push(created)
      return { ...created }
    },
  })
  return { store, makeModel }
})

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workflowRun: makeModel(store.workflowRun, () => ({
      businessId: 'ALMA_LIFESTYLE', status: 'active', state: 'started', stateVersion: 1,
      retryCount: 0, conversationId: null, pendingActionId: null,
      facts: null, nextAllowedTools: null, completedAt: null, leaseUntil: null,
    })),
    workflowRunEvent: makeModel(store.workflowRunEvent, () => ({})),
    agentOpenTask: makeModel(store.agentOpenTask, () => ({ status: 'open' })),
    agentPendingAction: makeModel(store.agentPendingAction, () => ({ status: 'pending' })),
    agentKvSetting: makeModel(store.agentKvSetting, () => ({})),
  },
}))

import { checkWorkflowGuards, onWorkflowToolExecuted } from '../workflow-guards'
import { createWorkflowRun, updateWorkflowFacts } from '../workflow-run'
import { createClientSeoBatchFacts } from '../client-seo-batch-state'

beforeEach(() => {
  store.workflowRun.length = 0
  store.workflowRunEvent.length = 0
  store.agentOpenTask.length = 0
  store.agentPendingAction.length = 0
  store.agentKvSetting.length = 0
})

const ctx = { conversationId: 'conv1', businessId: 'ALMA_LIFESTYLE' }

describe('post_without_preview guard', () => {
  it('blocks fb/ig post while the generated image is unconfirmed', async () => {
    await createWorkflowRun({
      conversationId: 'conv1', kind: 'product_post', goal: 'পোস্ট',
      state: 'preview_confirm', facts: { imageGenerated: true, previewConfirmed: false },
    })
    const fb = await checkWorkflowGuards('post_to_facebook', { page: 'lifestyle', message: 'x' }, ctx)
    expect(fb?.guard).toBe('post_without_preview')
    expect(fb?.error).toContain('ask_user')
    const ig = await checkWorkflowGuards('publish_to_instagram', { page: 'lifestyle', caption: 'x' }, ctx)
    expect(ig?.guard).toBe('post_without_preview')
  })

  it('allows the post once the owner confirmed the preview — and with no run at all', async () => {
    await createWorkflowRun({
      conversationId: 'conv1', kind: 'product_post', goal: 'পোস্ট',
      state: 'post_draft', facts: { imageGenerated: true, previewConfirmed: true },
    })
    expect(await checkWorkflowGuards('post_to_facebook', {}, ctx)).toBeNull()
    expect(await checkWorkflowGuards('post_to_facebook', {}, { conversationId: 'other' })).toBeNull()
  })

  it('allows an owner-uploaded-image post (no generated image in the run)', async () => {
    await createWorkflowRun({
      conversationId: 'conv1', kind: 'product_post', goal: 'পোস্ট', state: 'draft_ready', facts: {},
    })
    expect(await checkWorkflowGuards('post_to_facebook', {}, ctx)).toBeNull()
  })
})

describe('product_image_without_reference guard', () => {
  async function stashProductFacts() {
    await onWorkflowToolExecuted('get_product', { query: '720' }, {
      products: [{ sku: '720' }],
      images: [
        { productCode: '720-ADULT', storagePath: 'product-images/720-ADULT/1.jpg' },
        { productCode: '720-KIDS', storagePath: 'product-images/720-KIDS/1.jpg' },
      ],
    }, ctx)
  }

  it('blocks a product render without referenceImageId and lists the real paths', async () => {
    await stashProductFacts()
    const block = await checkWorkflowGuards('generate_image', { prompt: 'Studio shot of saree 720 family set' }, ctx)
    expect(block?.guard).toBe('product_image_without_reference')
    expect(block?.error).toContain('product-images/720-ADULT/1.jpg')
  })

  it('passes with a reference, for generic prompts, and without product facts', async () => {
    await stashProductFacts()
    expect(await checkWorkflowGuards('generate_image', {
      prompt: 'saree 720', referenceImageId: 'product-images/720-ADULT/1.jpg',
    }, ctx)).toBeNull()
    expect(await checkWorkflowGuards('generate_image', {
      prompt: 'Eid mubarak greeting card with crescent moon',
    }, ctx)).toBeNull()
    expect(await checkWorkflowGuards('generate_image', { prompt: 'saree shoot' }, { conversationId: 'fresh' })).toBeNull()
  })
})

describe('delegate_in_post_pipeline guard', () => {
  it('blocks content/marketing delegation while a product post is in flight', async () => {
    await createWorkflowRun({ conversationId: 'conv1', kind: 'product_post', goal: 'পোস্ট', state: 'draft_ready' })
    const block = await checkWorkflowGuards('delegate_to_specialist', { role: 'content', task: 'x' }, ctx)
    expect(block?.guard).toBe('delegate_in_post_pipeline')
  })

  it('allows other roles and delegation outside the pipeline', async () => {
    await createWorkflowRun({ conversationId: 'conv1', kind: 'product_post', goal: 'পোস্ট', state: 'draft_ready' })
    expect(await checkWorkflowGuards('delegate_to_specialist', { role: 'researcher', task: 'x' }, ctx)).toBeNull()
    expect(await checkWorkflowGuards('delegate_to_specialist', { role: 'marketer', task: 'x' }, { conversationId: 'c2' })).toBeNull()
  })
})

describe('repeated_navigation guard (§H)', () => {
  async function seedBrowserRun(session: Record<string, unknown>) {
    const run = await createWorkflowRun({
      conversationId: 'conv1', kind: 'browser_setup', goal: 'ব্রাউজার কাজ', state: 'session_active',
    })
    await updateWorkflowFacts(run.id, { browserSession: session })
    return run
  }

  it('blocks navigating to the page the session is already on', async () => {
    await seedBrowserRun({
      currentUrl: 'https://business.facebook.com/adsmanager',
      lastAction: 'click', lastActionOk: true, lastActionAt: new Date().toISOString(),
    })
    const block = await checkWorkflowGuards('live_browser_act', {
      action: 'navigate', url: 'https://business.facebook.com/adsmanager/',
    }, ctx)
    expect(block?.guard).toBe('repeated_navigation')
    expect(block?.error).toContain('live_browser_look')
  })

  it('allows re-navigation after a failed action or to a different page', async () => {
    await seedBrowserRun({
      currentUrl: 'https://business.facebook.com/adsmanager',
      lastAction: 'click', lastActionOk: false, lastActionAt: new Date().toISOString(),
    })
    expect(await checkWorkflowGuards('live_browser_act', {
      action: 'navigate', url: 'https://business.facebook.com/adsmanager',
    }, ctx)).toBeNull()
    expect(await checkWorkflowGuards('live_browser_act', {
      action: 'navigate', url: 'https://www.facebook.com',
    }, ctx)).toBeNull()
  })

  it('blocks a navigation ping-pong loop after one free retry', async () => {
    const now = Date.now()
    await seedBrowserRun({
      currentUrl: 'https://other.example.com',
      lastAction: 'navigate', lastActionOk: true, lastActionAt: new Date(now).toISOString(),
      navHistory: [
        { url: 'https://www.facebook.com', at: new Date(now - 60_000).toISOString() },
        { url: 'https://www.facebook.com', at: new Date(now - 30_000).toISOString() },
      ],
    })
    const block = await checkWorkflowGuards('live_browser_act', {
      action: 'navigate', url: 'https://www.facebook.com',
    }, ctx)
    expect(block?.guard).toBe('repeated_navigation')
    expect(block?.error).toContain('save_task_checkpoint')
  })

  it('never touches non-navigate actions', async () => {
    await seedBrowserRun({ currentUrl: 'https://x.com', lastActionOk: true, lastActionAt: new Date().toISOString() })
    expect(await checkWorkflowGuards('live_browser_act', { action: 'click', text: 'Next' }, ctx)).toBeNull()
  })
})

describe('ordered client SEO browser guard', () => {
  // 2026-07-16 incident: hard-locking to the CURRENT target deadlocked a real
  // job when one listed domain 301'd into the other. The guard's contract is
  // now: any LISTED target host is legal; unrelated hosts stay blocked.
  it('allows browsing any listed target, blocks unrelated hosts', async () => {
    await createWorkflowRun({
      conversationId: 'conv1',
      kind: 'client_seo_batch',
      goal: 'দুইটি site audit',
      state: 'target_1_browser_walk',
      facts: createClientSeoBatchFacts(['https://one.com', 'https://two.com'], {
        requireLiveBrowser: true,
        requireArtifact: true,
      }) as unknown as Record<string, unknown>,
      nextAllowedTools: ['live_browser_act'],
    })
    const secondTarget = await checkWorkflowGuards(
      'live_browser_look',
      { url: 'https://two.com', want: 'both' },
      { ...ctx, driveClientSeoBatch: true },
    )
    expect(secondTarget).toBeNull()

    const offList = await checkWorkflowGuards(
      'live_browser_look',
      { url: 'https://unrelated.com', want: 'both' },
      { ...ctx, driveClientSeoBatch: true },
    )
    expect(offList?.guard).toBe('client_seo_wrong_browser_target')
    expect(offList?.error).toContain('https://one.com')
  })
})

describe('post-execution hooks feed the machine', () => {
  it('a live browser ACT opens the browser_setup run and persists session state', async () => {
    await onWorkflowToolExecuted('live_browser_act', {
      action: 'navigate', url: 'https://business.facebook.com/adsmanager',
    }, { ok: true }, ctx)
    const run = store.workflowRun.find((r) => r.kind === 'browser_setup')
    expect(run).toBeDefined()
    const session = (run?.facts as { browserSession?: { currentUrl?: string; navHistory?: unknown[] } })?.browserSession
    expect(session?.currentUrl).toBe('https://business.facebook.com/adsmanager')
    expect(session?.navHistory).toHaveLength(1)
  })

  it('a pure look does NOT open a run, but updates an existing one', async () => {
    await onWorkflowToolExecuted('live_browser_look', {}, { currentUrl: 'https://x.com' }, ctx)
    expect(store.workflowRun).toHaveLength(0)
    await createWorkflowRun({ conversationId: 'conv1', kind: 'browser_setup', goal: 'কাজ', state: 'session_active' })
    await onWorkflowToolExecuted('live_browser_look', {}, { currentUrl: 'https://x.com' }, ctx)
    const session = (store.workflowRun[0].facts as { browserSession?: { currentUrl?: string } })?.browserSession
    expect(session?.currentUrl).toBe('https://x.com')
  })

  it('a resuming run\'s first look re-opens the working step (§H resume-by-look)', async () => {
    await createWorkflowRun({ conversationId: 'conv1', kind: 'browser_setup', goal: 'কাজ', state: 'resuming' })
    await onWorkflowToolExecuted('live_browser_look', {}, { currentUrl: 'https://x.com' }, ctx)
    expect(store.workflowRun[0].state).toBe('session_active')
  })

  it('extract_invoice opens the doc_extraction run at extracted', async () => {
    await onWorkflowToolExecuted('extract_invoice', { file_path: 'docs/inv1.jpg' }, { total: 4500 }, ctx)
    const run = store.workflowRun.find((r) => r.kind === 'doc_extraction')
    expect(run?.state).toBe('extracted')
    expect(run?.status).toBe('active')
  })
})

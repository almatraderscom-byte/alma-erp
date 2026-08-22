import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Phase 5 workflow-guard tests — the moved HARD RULEs run against an in-memory
 * prisma fake so the REAL guard logic executes. Browser effects deliberately
 * fail closed when a fresh observation cannot be established.
 */

const { store, makeModel, control, focusMock } = vi.hoisted(() => {
  type HRow = Record<string, unknown>
  const store: { workflowRun: HRow[]; workflowRunEvent: HRow[]; agentOpenTask: HRow[]; agentPendingAction: HRow[]; agentKvSetting: HRow[]; liveBrowserCommand: HRow[] } = {
    workflowRun: [], workflowRunEvent: [], agentOpenTask: [], agentPendingAction: [], agentKvSetting: [], liveBrowserCommand: [],
  }
  const control = { failNextWorkflowRunUpdateMany: false, failAllWorkflowRunUpdateMany: false }
  const focusMock = {
    ensureFocusForWorkflowRun: vi.fn(async () => null),
    syncFocusWithWorkflowRun: vi.fn(async () => undefined),
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
      if (table === store.workflowRun && (
        control.failAllWorkflowRunUpdateMany
        || control.failNextWorkflowRunUpdateMany
      )) {
        control.failNextWorkflowRunUpdateMany = false
        throw new Error('simulated workflow persistence failure')
      }
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
  return { store, makeModel, control, focusMock }
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
    liveBrowserCommand: makeModel(store.liveBrowserCommand, () => ({
      status: 'queued', result: null, error: null, resolvedAt: null,
    })),
  },
}))

vi.mock('@/agent/lib/conversation-focus', () => focusMock)

import {
  checkWorkflowGuards,
  consumeLiveBrowserObservationReceipt,
  onWorkflowToolExecuted,
  persistLiveBrowserActOutcome,
  recordLiveBrowserLookReceipt,
} from '../workflow-guards'
import { createWorkflowRun, updateWorkflowFacts } from '../workflow-run'
import { createClientSeoBatchFacts } from '../client-seo-batch-state'

beforeEach(() => {
  store.workflowRun.length = 0
  store.workflowRunEvent.length = 0
  store.agentOpenTask.length = 0
  store.agentPendingAction.length = 0
  store.agentKvSetting.length = 0
  store.liveBrowserCommand.length = 0
  control.failNextWorkflowRunUpdateMany = false
  control.failAllWorkflowRunUpdateMany = false
  focusMock.ensureFocusForWorkflowRun.mockClear()
  focusMock.syncFocusWithWorkflowRun.mockClear()
  delete process.env.AGENT_WORKFLOW_GUARDS
})

const ctx = { conversationId: 'conv1', businessId: 'ALMA_LIFESTYLE', turnId: 'turn-1' }

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
      lastAction: 'look', lastActionOk: true, lastActionAt: new Date().toISOString(), lastTurnId: 'turn-1',
    })
    const block = await checkWorkflowGuards('live_browser_act', {
      action: 'navigate', url: 'https://business.facebook.com/adsmanager/',
    }, ctx)
    expect(block?.guard).toBe('repeated_navigation')
    expect(block?.error).toContain('live_browser_look')
  })

  it('a failed navigation does not trigger the repeated-navigation block', async () => {
    await seedBrowserRun({
      currentUrl: 'https://business.facebook.com/adsmanager',
      lastAction: 'click', lastActionOk: false, lastActionAt: new Date().toISOString(), lastTurnId: 'turn-1',
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
      lastAction: 'look', lastActionOk: true, lastActionAt: new Date(now).toISOString(), lastTurnId: 'turn-1',
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

})

describe('one-use live-browser observation receipt', () => {
  const lookData = {
    device: 'My Mac Chrome',
    deviceId: 'device-mac-1',
    currentUrl: 'https://x.com/home',
    documentId: 'doc-x-home-1',
    domObservationId: 'dom-generation-1',
    page: { url: 'https://x.com/home', title: 'Home', text: 'current page text', documentId: 'doc-x-home-1' },
    elements: [{ ref: 'e1', text: 'Next', fingerprint: '["button","","button","","Next",""]' }],
  }

  it('stores and returns a turn/device/URL/document-bound receipt, then consumes it once', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    expect(receipt).toMatchObject({
      device: 'My Mac Chrome',
      deviceId: 'device-mac-1',
      currentUrl: 'https://x.com/home',
      documentId: expect.any(String),
      domObservationId: 'dom-generation-1',
      observationReceipt: expect.any(String),
      observationIssuedAt: expect.any(String),
    })
    expect(receipt.observationReceipt.length).toBeGreaterThan(20)
    expect(Date.parse(receipt.observationExpiresAt) - Date.now()).toBeLessThanOrEqual(45_000)

    const input = {
      action: 'click', text: 'Next', ref: 'e1', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({
      blocked: false,
      claim: {
        deviceId: receipt.deviceId,
        currentUrl: receipt.currentUrl,
        documentId: receipt.documentId,
        domObservationId: 'dom-generation-1',
        allowedRefs: ['e1'],
        refFingerprints: { e1: lookData.elements[0].fingerprint },
      },
    })
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({
      blocked: true, guard: 'fresh_browser_look_required',
    })

    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    expect(session).toMatchObject({
      observationReceipt: receipt.observationReceipt,
      observationState: 'pending',
      currentUrl: receipt.currentUrl,
      documentId: receipt.documentId,
      device: receipt.device,
      deviceId: receipt.deviceId,
      domObservationId: 'dom-generation-1',
    })
  })

  it('round-trips the server-derived direct-browser owner request lane', async () => {
    const lane = 'play a requested song on youtube'
    const receipt = await recordLiveBrowserLookReceipt(lookData, {
      ...ctx,
      directBrowserOwnerRequest: lane,
    })
    expect(receipt.directBrowserOwnerRequest).toBe(lane)
    const consumed = await consumeLiveBrowserObservationReceipt({
      action: 'navigate',
      url: 'https://www.youtube.com/',
      device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }, ctx)
    expect(consumed).toMatchObject({
      blocked: false,
      claim: { directBrowserOwnerRequest: lane, deviceId: 'device-mac-1' },
    })
    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    expect(session.directBrowserOwnerRequest).toBe(lane)
  })

  it('requires an observed ref for every element-targeted action', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const base = { action: 'click', device: receipt.device, observationReceipt: receipt.observationReceipt }
    expect(await consumeLiveBrowserObservationReceipt(base, ctx))
      .toMatchObject({ blocked: true, guard: 'browser_observation_ref_required' })
    expect(await consumeLiveBrowserObservationReceipt({ ...base, ref: 'e999' }, ctx))
      .toMatchObject({ blocked: true, guard: 'browser_observation_ref_mismatch' })
    expect(await consumeLiveBrowserObservationReceipt({ ...base, ref: 'e1', selector: '#arbitrary' }, ctx))
      .toMatchObject({ blocked: false, claim: { allowedRefs: ['e1'] } })
  })

  it('requires a DOM generation and semantic fingerprint for ref-bound actions', async () => {
    const noGeneration = await recordLiveBrowserLookReceipt({
      ...lookData,
      domObservationId: undefined,
    }, ctx)
    const input = {
      action: 'click', ref: 'e1', device: noGeneration.device,
      observationReceipt: noGeneration.observationReceipt,
    }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({
      blocked: true,
      guard: 'browser_observation_dom_generation_missing',
    })
  })

  it('allows only one concurrent consumer of the same receipt', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const input = { action: 'click', text: 'Next', ref: 'e1', device: receipt.device, observationReceipt: receipt.observationReceipt }
    const outcomes = await Promise.all([
      consumeLiveBrowserObservationReceipt(input, ctx),
      consumeLiveBrowserObservationReceipt(input, ctx),
    ])
    expect(outcomes.filter((value) => !value.blocked)).toHaveLength(1)
    expect(outcomes.filter((value) => value.blocked)).toHaveLength(1)
  })

  it('refuses a new LOOK from overwriting a pending act, including a concurrent ref rebind', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const input = {
      action: 'click', ref: 'e1', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({ blocked: false })

    await expect(recordLiveBrowserLookReceipt({
      ...lookData,
      domObservationId: 'dom-generation-2',
      elements: [{ ref: 'e1', text: 'Different target', fingerprint: '["a","","link","","Different",""]' }],
    }, ctx)).rejects.toThrow('browser_observation_act_pending')

    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    expect(session).toMatchObject({
      observationState: 'pending',
      observationReceipt: receipt.observationReceipt,
      domObservationId: 'dom-generation-1',
      refFingerprints: { e1: lookData.elements[0].fingerprint },
    })
  })

  it('reconciles an exact terminal durable command before allowing a fresh LOOK', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    await consumeLiveBrowserObservationReceipt({
      action: 'click', ref: 'e1', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }, ctx)
    const pending = ((store.workflowRun[0].facts as {
      browserSession: { pendingAct: Record<string, unknown> }
    }).browserSession.pendingAct)
    store.liveBrowserCommand.push({
      id: pending.commandId,
      deviceId: pending.deviceId,
      conversationId: ctx.conversationId,
      turnId: pending.turnId,
      action: pending.action,
      status: 'failed',
      error: 'delivery_outcome_unknown',
      resolvedAt: new Date(),
    })

    const next = await recordLiveBrowserLookReceipt({
      ...lookData,
      domObservationId: 'dom-generation-2',
    }, ctx)
    expect(next.observationReceipt).not.toBe(receipt.observationReceipt)
    expect((store.workflowRun[0].facts as {
      browserSession: Record<string, unknown>
    }).browserSession).toMatchObject({ observationState: 'ready', pendingAct: null })
  })

  it('never reopens a pending receipt while its durable command is queued or delivered', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    await consumeLiveBrowserObservationReceipt({
      action: 'click', ref: 'e1', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }, ctx)
    const pending = ((store.workflowRun[0].facts as {
      browserSession: { pendingAct: Record<string, unknown> }
    }).browserSession.pendingAct)
    store.liveBrowserCommand.push({
      id: pending.commandId,
      deviceId: pending.deviceId,
      conversationId: ctx.conversationId,
      turnId: pending.turnId,
      action: pending.action,
      status: 'delivered',
      resolvedAt: null,
    })
    await expect(recordLiveBrowserLookReceipt({
      ...lookData, domObservationId: 'dom-generation-2',
    }, ctx)).rejects.toThrow('browser_observation_act_pending')
  })

  it('tombstones an old no-command reservation before allowing a fresh LOOK', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    await consumeLiveBrowserObservationReceipt({
      action: 'click', ref: 'e1', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }, ctx)
    const session = (store.workflowRun[0].facts as {
      browserSession: { pendingAct: Record<string, unknown> }
    }).browserSession
    const commandId = String(session.pendingAct.commandId)
    session.pendingAct.startedAt = new Date(Date.now() - 3 * 60_000).toISOString()

    await expect(recordLiveBrowserLookReceipt({
      ...lookData, domObservationId: 'dom-generation-2',
    }, ctx)).resolves.toMatchObject({ domObservationId: 'dom-generation-2' })
    expect(store.liveBrowserCommand).toContainEqual(expect.objectContaining({
      id: commandId,
      status: 'failed',
      error: expect.stringContaining('pre_dispatch_abandoned'),
    }))
  })

  it('preserves a concurrent facts merge instead of overwriting the receipt claim', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const run = store.workflowRun[0]
    const input = { action: 'click', ref: 'e1', device: receipt.device, observationReceipt: receipt.observationReceipt }
    const [, consumed] = await Promise.all([
      updateWorkflowFacts(String(run.id), { unrelatedFact: 'preserved' }),
      consumeLiveBrowserObservationReceipt(input, ctx),
    ])
    expect(consumed).toMatchObject({ blocked: false })
    expect(store.workflowRun[0].facts).toMatchObject({
      unrelatedFact: 'preserved',
      browserSession: { observationState: 'pending', observationReceipt: receipt.observationReceipt },
    })
  })

  it('rejects missing context, wrong receipt, wrong turn, wrong device, and expiry even when guards are disabled', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const valid = { action: 'click', ref: 'e1', device: receipt.device, observationReceipt: receipt.observationReceipt }

    process.env.AGENT_WORKFLOW_GUARDS = 'false'
    expect(await consumeLiveBrowserObservationReceipt(valid, { conversationId: 'conv1' }))
      .toMatchObject({ blocked: true, guard: 'browser_observation_context_required' })
    expect(await consumeLiveBrowserObservationReceipt({ ...valid, observationReceipt: 'wrong' }, ctx))
      .toMatchObject({ blocked: true, guard: 'browser_observation_receipt_mismatch' })
    expect(await consumeLiveBrowserObservationReceipt(valid, { ...ctx, turnId: 'turn-2' }))
      .toMatchObject({ blocked: true, guard: 'browser_observation_turn_mismatch' })
    expect(await consumeLiveBrowserObservationReceipt({ ...valid, device: 'Windows Chrome' }, ctx))
      .toMatchObject({ blocked: true, guard: 'browser_observation_device_mismatch' })

    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    session.observationExpiresAt = new Date(Date.now() - 1).toISOString()
    expect(await consumeLiveBrowserObservationReceipt(valid, ctx))
      .toMatchObject({ blocked: true, guard: 'browser_observation_expired' })
  })

  it('persists success/failure outcome against pending state and requires a new look', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const input = {
      action: 'navigate', url: 'https://x.com/explore', device: receipt.device,
      observationReceipt: receipt.observationReceipt,
    }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({ blocked: false })
    await persistLiveBrowserActOutcome(input, { device: receipt.device }, ctx, {
      success: false, path: 'handler', errorCode: 'not_found',
    })
    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    expect(session).toMatchObject({
      observationState: 'consumed',
      pendingAct: null,
      lastAction: 'navigate',
      lastActionOk: false,
      lastOutcome: { receipt: receipt.observationReceipt, success: false, path: 'handler', errorCode: 'not_found' },
    })
    expect(await consumeLiveBrowserObservationReceipt(input, ctx))
      .toMatchObject({ blocked: true, guard: 'fresh_browser_look_required' })
    const next = await recordLiveBrowserLookReceipt({
      ...lookData,
      currentUrl: 'https://x.com/explore',
      documentId: 'doc-x-explore-1',
      domObservationId: 'dom-generation-2',
      page: { ...lookData.page, url: 'https://x.com/explore', documentId: 'doc-x-explore-1' },
    }, ctx)
    expect(next.observationReceipt).not.toBe(receipt.observationReceipt)
    expect(await consumeLiveBrowserObservationReceipt({ ...input, observationReceipt: next.observationReceipt }, ctx))
      .toMatchObject({ blocked: false })
  })

  it('leaves the receipt pending and blocks replay when outcome persistence fails', async () => {
    const receipt = await recordLiveBrowserLookReceipt(lookData, ctx)
    const input = { action: 'click', ref: 'e1', device: receipt.device, observationReceipt: receipt.observationReceipt }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({ blocked: false })
    control.failNextWorkflowRunUpdateMany = true
    await expect(persistLiveBrowserActOutcome(input, null, ctx, { success: true, path: 'handler' }))
      .rejects.toThrow('simulated workflow persistence failure')
    const session = (store.workflowRun[0].facts as { browserSession: Record<string, unknown> }).browserSession
    expect(session.observationState).toBe('pending')
    expect(await consumeLiveBrowserObservationReceipt(input, ctx))
      .toMatchObject({ blocked: true, guard: 'fresh_browser_look_required' })
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
    const receipt = await recordLiveBrowserLookReceipt({
      currentUrl: 'https://x.com', device: 'My Mac Chrome', deviceId: 'device-mac-1', documentId: 'doc-x-1',
      page: { url: 'https://x.com', title: 'Home', documentId: 'doc-x-1' },
    }, ctx)
    const input = {
      action: 'navigate', url: 'https://business.facebook.com/adsmanager',
      device: receipt.device, observationReceipt: receipt.observationReceipt,
    }
    expect(await consumeLiveBrowserObservationReceipt(input, ctx)).toMatchObject({ blocked: false })
    await onWorkflowToolExecuted('live_browser_act', input, { ok: true }, ctx)
    const run = store.workflowRun.find((r) => r.kind === 'browser_setup')
    expect(run).toBeDefined()
    const session = (run?.facts as { browserSession?: { currentUrl?: string; navHistory?: unknown[] } })?.browserSession
    expect(session?.currentUrl).toBe('https://business.facebook.com/adsmanager')
    expect(session?.navHistory).toHaveLength(1)
  })

  it('the first look opens a run and records the turn-bound observation', async () => {
    await onWorkflowToolExecuted('live_browser_look', {}, {
      currentUrl: 'https://x.com', device: 'My Mac Chrome', deviceId: 'device-mac-1', documentId: 'doc-x-1',
    }, ctx)
    expect(store.workflowRun).toHaveLength(1)
    const session = (store.workflowRun[0].facts as {
      browserSession?: { currentUrl?: string; lastAction?: string; lastTurnId?: string; lastDevice?: string }
    })?.browserSession
    expect(session?.currentUrl).toBe('https://x.com')
    expect(session).toMatchObject({ lastAction: 'look', lastTurnId: 'turn-1', lastDevice: 'My Mac Chrome' })
    expect(focusMock.ensureFocusForWorkflowRun).toHaveBeenCalledTimes(1)
  })

  it('does not let direct browser receipt bookkeeping park the direct lane focus', async () => {
    await onWorkflowToolExecuted('live_browser_look', {}, {
      currentUrl: 'https://www.youtube.com/',
      device: 'My Mac Chrome',
      deviceId: 'device-mac-1',
      documentId: 'doc-youtube-1',
    }, {
      ...ctx,
      directBrowserOwnerRequest: 'Play Fix You on YouTube.',
    })

    expect(store.workflowRun).toHaveLength(1)
    expect(store.workflowRun[0]).toMatchObject({ kind: 'browser_setup', state: 'session_active' })
    expect(focusMock.ensureFocusForWorkflowRun).not.toHaveBeenCalled()
  })

  it('restores workflow focus when an ordinary browser task reuses a direct receipt run', async () => {
    const observation = {
      currentUrl: 'https://www.youtube.com/',
      device: 'My Mac Chrome',
      deviceId: 'device-mac-1',
      documentId: 'doc-youtube-1',
    }
    await onWorkflowToolExecuted('live_browser_look', {}, observation, {
      ...ctx,
      directBrowserOwnerRequest: 'Play Fix You on YouTube.',
    })
    expect(focusMock.ensureFocusForWorkflowRun).not.toHaveBeenCalled()

    await onWorkflowToolExecuted('live_browser_look', {}, observation, ctx)

    expect(store.workflowRun).toHaveLength(1)
    expect(focusMock.ensureFocusForWorkflowRun).toHaveBeenCalledTimes(1)
    expect(focusMock.ensureFocusForWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: store.workflowRun[0].id, kind: 'browser_setup' }),
      'browser_receipt_reuse',
      {
        activateExisting: true,
        ownerFence: { conversationId: 'conv1', turnId: 'turn-1' },
      },
    )
  })

  it('does not restore ordinary focus when LOOK receipt persistence fails', async () => {
    control.failAllWorkflowRunUpdateMany = true

    await onWorkflowToolExecuted('live_browser_look', {}, {
      currentUrl: 'https://www.youtube.com/',
      device: 'My Mac Chrome',
      deviceId: 'device-mac-1',
      documentId: 'doc-youtube-1',
    }, ctx)

    expect(focusMock.ensureFocusForWorkflowRun).not.toHaveBeenCalled()
  })

  it('a resuming run\'s first look re-opens the working step (§H resume-by-look)', async () => {
    await createWorkflowRun({ conversationId: 'conv1', kind: 'browser_setup', goal: 'কাজ', state: 'resuming' })
    await onWorkflowToolExecuted('live_browser_look', {}, {
      currentUrl: 'https://x.com', device: 'My Mac Chrome', deviceId: 'device-mac-1', documentId: 'doc-x-1',
    }, ctx)
    expect(store.workflowRun[0].state).toBe('session_active')
  })

  it('extract_invoice opens the doc_extraction run at extracted', async () => {
    await onWorkflowToolExecuted('extract_invoice', { file_path: 'docs/inv1.jpg' }, { total: 4500 }, ctx)
    const run = store.workflowRun.find((r) => r.kind === 'doc_extraction')
    expect(run?.state).toBe('extracted')
    expect(run?.status).toBe('active')
  })
})

/**
 * The batch guard must STEER the head, not kill its turn.
 *
 * Live run 2026-07-25: the head polled the audit while the crawl was running,
 * the crawl finished between two rounds, and its next status-only check was
 * rejected as a contract failure. The turn ended on "⚠️ বাধ্যতামূলক ধাপ … সফল
 * হয়নি" and the finished report was never read. The server already knows which
 * read is due, so the guard now fills it in instead of blocking.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createClientSeoBatchFacts,
  reduceClientSeoBatch,
  type ClientSeoBatchFacts,
} from '@/agent/lib/client-seo-batch-state'

let facts: ClientSeoBatchFacts

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/agent/lib/workflow-run', () => ({
  listActiveWorkflowRuns: async () => [{ kind: 'client_seo_batch', facts, id: 'run-1' }],
  ensureActiveWorkflowRun: async () => ({}),
  transitionWorkflowRun: async () => ({}),
  WorkflowVersionConflictError: class extends Error {},
}))
vi.mock('@/agent/lib/graph/seo-batch-graph', () => ({ mirrorSeoBatchTransition: async () => {} }))

const { guardClientSeoBatchTool } = await import('@/agent/lib/client-seo-batch')

beforeEach(() => {
  facts = createClientSeoBatchFacts(['https://almatraders.com'], {
    requireLiveBrowser: false,
    requireArtifact: true,
  })
})

function finishAudit() {
  facts = reduceClientSeoBatch(facts, { type: 'audit_queued', actionId: 'a1' })
  facts = reduceClientSeoBatch(facts, { type: 'audit_finished', actionId: 'a1', ok: true })
}

describe('check_website_seo_audit steering', () => {
  it('a status-only poll is corrected to read:"report" instead of blocked', async () => {
    finishAudit()
    const input: Record<string, unknown> = { pendingActionId: 'a1' }
    const block = await guardClientSeoBatchTool('conv-1', 'check_website_seo_audit', input)
    expect(block).toBeNull()
    expect(input.read).toBe('report')
  })

  it('once the report is read the next call is steered to the links', async () => {
    finishAudit()
    facts = reduceClientSeoBatch(facts, { type: 'report_read', actionId: 'a1' })
    const input: Record<string, unknown> = { pendingActionId: 'a1', read: 'json' }
    const block = await guardClientSeoBatchTool('conv-1', 'check_website_seo_audit', input)
    expect(block).toBeNull()
    expect(input.read).toBe('links')
  })

  it('leaves a plain status poll alone while the crawl is still running', async () => {
    facts = reduceClientSeoBatch(facts, { type: 'audit_queued', actionId: 'a1' })
    const input: Record<string, unknown> = { pendingActionId: 'a1' }
    const block = await guardClientSeoBatchTool('conv-1', 'check_website_seo_audit', input)
    expect(block).toBeNull()
    expect(input.read).toBeUndefined()
  })

  it('still blocks a crawl started out of target order', async () => {
    const two = createClientSeoBatchFacts(['https://one.com', 'https://two.com'], {
      requireLiveBrowser: false,
      requireArtifact: true,
    })
    facts = two
    const block = await guardClientSeoBatchTool('conv-1', 'run_website_seo_audit', { url: 'https://two.com' })
    expect(block?.guard).toBe('client_seo_wrong_target_order')
  })
})

import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_TEMPLATES,
  templateKindsForCardType,
  templateCardTransition,
  expectedToolFor,
  workflowToolBinding,
  nextAllowedToolsFor,
} from '../workflow-templates'
import { TERMINAL_WORKFLOW_STATUSES } from '../workflow-run-types'
import { TOOLS } from '@/agent/tools/registry'
import { CORE_PACK, DOMAIN_PACKS, HEAD_TOOL_HARD_LIMIT, assemblePack } from '@/agent/tools/state-router'

/**
 * Phase 5 exit-gate integrity tests — generated from the templates themselves,
 * so adding/renaming a step or tool breaks CI, never a live turn.
 */

const OWNER_TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

describe('workflow template integrity', () => {
  it('ships the seven roadmap templates', () => {
    expect(Object.keys(WORKFLOW_TEMPLATES).sort()).toEqual([
      'ad_campaign', 'audience', 'browser_setup', 'doc_extraction',
      'finance_approval', 'product_post', 'staff_task',
    ])
  })

  for (const [kind, tpl] of Object.entries(WORKFLOW_TEMPLATES)) {
    describe(`template ${kind}`, () => {
      it('kind matches its key and entry step exists', () => {
        expect(tpl.kind).toBe(kind)
        expect(tpl.steps[tpl.entry]).toBeDefined()
      })

      it('every next-step target exists (no dead transitions)', () => {
        for (const [stepId, step] of Object.entries(tpl.steps)) {
          for (const n of step.next) {
            expect(tpl.steps[n], `${kind}.${stepId} → ${n}`).toBeDefined()
          }
        }
      })

      it('has at least one terminal step, and terminal steps have no next', () => {
        const terminals = Object.entries(tpl.steps).filter(
          ([, s]) => s.status && TERMINAL_WORKFLOW_STATUSES.includes(s.status),
        )
        expect(terminals.length).toBeGreaterThan(0)
        for (const [stepId, s] of terminals) {
          expect(s.next, `${kind}.${stepId} is terminal`).toHaveLength(0)
        }
      })

      it('every allowed tool is a real executable owner tool', () => {
        for (const [stepId, step] of Object.entries(tpl.steps)) {
          for (const tool of step.allowedTools) {
            expect(OWNER_TOOL_NAMES.has(tool), `${kind}.${stepId} → ${tool}`).toBe(true)
          }
        }
      })

      it('CORE + any step pack stays within the 24-tool hard limit', () => {
        for (const [stepId, step] of Object.entries(tpl.steps)) {
          const { trimmed } = assemblePack([], step.allowedTools)
          expect(
            CORE_PACK.length + step.allowedTools.length,
            `${kind}.${stepId} exceeds head budget`,
          ).toBeLessThanOrEqual(HEAD_TOOL_HARD_LIMIT)
          expect(trimmed, `${kind}.${stepId} trimmed`).toHaveLength(0)
        }
      })

      it('router pack is a real DOMAIN_PACKS key', () => {
        expect(tpl.routerPack in DOMAIN_PACKS).toBe(true)
      })

      it('card steps reference real steps and their card types map back here', () => {
        for (const [cardType, cs] of Object.entries(tpl.cardSteps)) {
          expect(tpl.steps[cs.stage], `${kind}.cardSteps.${cardType}.stage`).toBeDefined()
          expect(tpl.steps[cs.onExecuted], `${kind}.cardSteps.${cardType}.onExecuted`).toBeDefined()
          if (cs.onRejected) expect(tpl.steps[cs.onRejected]).toBeDefined()
          if (cs.onApproved) expect(tpl.steps[cs.onApproved]).toBeDefined()
          expect(templateKindsForCardType(cardType), `${cardType} routes to ${kind}`).toContain(kind)
        }
      })

      it('expectedTool resolves to a tool inside the step pack', () => {
        for (const [stepId, step] of Object.entries(tpl.steps)) {
          if (!step.expectedTool) continue
          const facts: Record<string, unknown> = {}
          for (const k of step.requiresFacts ?? []) facts[k] = true
          const name = expectedToolFor(kind, stepId, facts)
          if (name) {
            expect(step.allowedTools, `${kind}.${stepId} expectedTool`).toContain(name)
          }
        }
      })
    })
  }

  it('approval-gated writes never expose their publish tool before the gate (product_post invariant)', () => {
    // The 2026-07-13 incident class as a machine invariant: post tools are
    // physically absent from every step before preview_confirm passes.
    for (const stepId of ['creative_approval', 'rendering', 'preview_confirm']) {
      const tools = nextAllowedToolsFor('product_post', stepId) ?? []
      expect(tools).not.toContain('post_to_facebook')
      expect(tools).not.toContain('publish_to_instagram')
    }
    expect(nextAllowedToolsFor('product_post', 'post_draft')).toContain('post_to_facebook')
  })

  it('browser resume step exposes ONLY look (roadmap §H: resume begins with look)', () => {
    expect(nextAllowedToolsFor('browser_setup', 'resuming')).toEqual(['live_browser_look'])
  })
})

describe('templateCardTransition', () => {
  it('executed image card advances, not closes; executed post card closes with done', () => {
    expect(templateCardTransition('product_post', 'image_gen', 'executed')).toEqual({
      toState: 'preview_confirm', toStatus: 'active',
    })
    expect(templateCardTransition('product_post', 'fb_post', 'executed')).toEqual({
      toState: 'published_verified', toStatus: 'done',
    })
  })

  it('rejected image card = revision, unknown kinds/cards = null (legacy behavior)', () => {
    expect(templateCardTransition('product_post', 'image_gen', 'rejected')).toEqual({
      toState: 'draft_ready', toStatus: 'active',
    })
    expect(templateCardTransition('social', 'fb_post', 'executed')).toBeNull()
    expect(templateCardTransition('product_post', 'seo_audit', 'executed')).toBeNull()
  })

  it('approved worker cards move to their waiting_worker step', () => {
    expect(templateCardTransition('staff_task', 'dispatch_staff_tasks', 'approved')).toEqual({
      toState: 'dispatching', toStatus: 'waiting_worker',
    })
    expect(templateCardTransition('product_post', 'image_gen', 'approved')).toEqual({
      toState: 'rendering', toStatus: 'waiting_worker',
    })
  })
})

describe('workflowToolBinding (roadmap §D per-phase tool_choice)', () => {
  const postDraftRun = {
    kind: 'product_post', state: 'post_draft', status: 'active',
    facts: { previewConfirmed: true } as Record<string, unknown>,
  }

  it('binds the named tool on a continuation with exactly one deterministic run', () => {
    expect(workflowToolBinding([postDraftRun], { continuation: true })).toEqual({ toolName: 'post_to_facebook' })
  })

  it('facts pick the platform variant', () => {
    const ig = { ...postDraftRun, facts: { previewConfirmed: true, platform: 'instagram' } }
    expect(workflowToolBinding([ig], { continuation: true })).toEqual({ toolName: 'publish_to_instagram' })
  })

  it('never binds without continuation, with missing facts, or with two active runs', () => {
    expect(workflowToolBinding([postDraftRun], { continuation: false })).toBeNull()
    const noFacts = { ...postDraftRun, facts: {} }
    expect(workflowToolBinding([noFacts], { continuation: true })).toBeNull()
    expect(workflowToolBinding([postDraftRun, { ...postDraftRun }], { continuation: true })).toBeNull()
  })

  it('never binds while waiting on the owner or for non-template runs', () => {
    const waiting = { ...postDraftRun, status: 'waiting_owner' }
    expect(workflowToolBinding([waiting], { continuation: true })).toBeNull()
    const legacy = { kind: 'social', state: 'awaiting_approval', status: 'active', facts: null }
    expect(workflowToolBinding([legacy], { continuation: true })).toBeNull()
  })
})

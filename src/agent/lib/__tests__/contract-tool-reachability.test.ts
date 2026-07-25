/**
 * Structural invariant: every tool a server-side contract can DEMAND must be
 * reachable in the tool pack that contract runs under.
 *
 * The client-SEO batch could end up requiring `complete_skill_pack_run`, a tool
 * the state router never loaded. The head then physically could not satisfy the
 * contract, so its reply was replaced by a progress placeholder — for good.
 * That is how the owner's finished audit turned into "⏳ কাজ চলমান" instead of a
 * report (2026-07-25). This test fails CI if any state a contract can enter
 * demands a tool the pack does not contain.
 */
import { describe, expect, it } from 'vitest'
import { CORE_PACK, DOMAIN_PACKS } from '@/agent/tools/state-router'
import {
  clientSeoBatchRequiredTool,
  createClientSeoBatchFacts,
  reduceClientSeoBatch,
  type ClientSeoBatchEvent,
  type ClientSeoBatchFacts,
} from '@/agent/lib/client-seo-batch-state'

/** Tools available on a client-SEO turn: the always-on core + the matched packs. */
const REACHABLE = new Set<string>([
  ...CORE_PACK,
  ...DOMAIN_PACKS.seo,
  ...DOMAIN_PACKS.website,
  ...DOMAIN_PACKS.browser,
])

/** Walk every reachable state of the batch machine and collect demanded tools. */
function everyDemandedTool(targets: string[], requireLiveBrowser: boolean): Set<string> {
  const demanded = new Set<string>()
  const seen = new Set<string>()
  const queue: ClientSeoBatchFacts[] = [
    createClientSeoBatchFacts(targets, { requireLiveBrowser, requireArtifact: true }),
  ]
  const events: ClientSeoBatchEvent[] = [
    { type: 'browser_act' },
    { type: 'browser_look', url: `${targets[0]}/page` },
    { type: 'audit_queued', actionId: 'a1' },
    { type: 'audit_finished', actionId: 'a1', ok: true },
    { type: 'audit_finished', actionId: 'a1', ok: false },
    { type: 'report_read', actionId: 'a1' },
    { type: 'links_read', actionId: 'a1' },
    { type: 'pack_completed' },
  ]

  while (queue.length) {
    const facts = queue.shift()!
    const key = JSON.stringify(facts)
    if (seen.has(key)) continue
    seen.add(key)
    const required = clientSeoBatchRequiredTool(facts)
    if (required) demanded.add(required)
    if (seen.size > 400) break // the machine is small; this is a runaway guard
    for (const event of events) queue.push(reduceClientSeoBatch(facts, event))
  }
  return demanded
}

describe('client_seo batch contract is satisfiable', () => {
  it.each([
    ['single target, crawler only', ['https://almatraders.com'], false],
    ['single target, live browser required', ['https://almatraders.com'], true],
    ['two ordered targets', ['https://one.com', 'https://two.com'], true],
  ])('%s — every demanded tool is in the loaded pack', (_label, targets, requireLiveBrowser) => {
    const demanded = everyDemandedTool(targets as string[], requireLiveBrowser as boolean)
    expect(demanded.size).toBeGreaterThan(0)
    const missing = [...demanded].filter((tool) => !REACHABLE.has(tool))
    expect(missing).toEqual([])
  })

  it('the completion gate specifically is reachable', () => {
    expect(REACHABLE.has('complete_skill_pack_run')).toBe(true)
  })

  it('the artifact tool is reachable so a deliverable can always be filed', () => {
    expect(REACHABLE.has('save_artifact')).toBe(true)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Codex P1 ×2 (PR #845). The clients must never infer the reference contract's
 * state from the shape of `references`:
 *
 *  - inferring "inactive" from an empty array turns every legacy link and every
 *    trusted tool screenshot inert on a replayed/tail terminal in off/shadow;
 *  - inferring "active" from a present array leaves model-authored links
 *    clickable while the rollout is genuinely ON but the reply cited nothing.
 *
 * So every terminal that carries a reference projection carries the explicit
 * flag beside it, and while ON an empty projection is sent rather than omitted.
 * These are source assertions because the emit sites live inside long streaming
 * generators that cannot be driven without a provider and a database.
 */
const SOURCES = [
  'src/agent/lib/core.ts',
  'src/agent/lib/models/run-owner-turn.ts',
] as const

function read(path: string): string {
  return readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8')
}

describe('verified-reference stream contract', () => {
  it.each(SOURCES)('%s: EVERY terminal states the contract, not just the citing ones', (path) => {
    const source = read(path)
    const lines = source.split('\n')
    const terminals = lines.flatMap((line, index) => (
      line.includes("type: 'done'") && !line.trimStart().startsWith('|') ? [index] : []
    ))
    expect(terminals.length).toBeGreaterThan(0)
    for (const index of terminals) {
      // An early terminal (answer-gate hit, route-guard blocker) cites nothing,
      // but a cached answer can still carry Markdown links — leaving the client
      // in legacy mode keeps those clickable under an ON contract (Codex P2).
      const block = lines.slice(index, index + 14).join('\n')
      expect(block, lines[index].trim().slice(0, 120)).toContain('referencesActive:')
    }
  })

  it.each(SOURCES)('%s: every references event states the contract', (path) => {
    const source = read(path)
    const events = source.split('\n').filter((line) => line.includes("type: 'references'"))
    for (const line of events) {
      if (line.includes('|')) continue // the AgentEvent union declaration
      expect(line, line.trim().slice(0, 120)).toContain('referencesActive:')
    }
  })

  it.each(SOURCES)('%s: an ON turn sends an authoritative empty projection', (path) => {
    const source = read(path)
    // Never `references.length ? references : undefined` — that omission is what
    // left an ON turn with no citations stuck in legacy rendering until reload.
    expect(source).not.toMatch(/references: visible\w*References\.length[^\n]*undefined/)
    expect(source).toMatch(/ContractActive \? visible\w*References : undefined/)
  })

  it('the hidden-mode sanitizer says inactive rather than merely empty', () => {
    const source = read('src/agent/lib/turn-events.ts')
    expect(source).toContain('references: [], referencesActive: false')
  })
})

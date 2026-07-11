import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { buildSystemPromptBlocks, type BuildSystemPromptArgs } from '@/agent/lib/system-prompt'
import { buildTurnApiMessages } from '@/agent/lib/core'

/**
 * B1 — prompt-cache prefix stability.
 *
 * Root cause (pre-fix): the volatile per-turn context (salah hints, business
 * snapshot, relevant memories, conflict signals…) was concatenated into the
 * `system:` array. Because those bytes change every turn, the whole prefix that
 * sits before the conversation-history cache breakpoint differed every turn, so
 * the history breakpoint never cache-HIT and the entire message history was
 * re-billed at full input price each turn.
 *
 * The fix moves volatile OUT of the system block and INTO the current owner user
 * turn. These tests lock in two byte-stability properties that make the history
 * cache actually hit:
 *   1. The `system:` block is byte-identical across turns even when per-turn
 *      context differs.
 *   2. The conversation-history prefix (everything before the current owner turn)
 *      is byte-identical across two consecutive turns — only the current/new
 *      turn carries the changing volatile context.
 */

const BASE: BuildSystemPromptArgs = {
  businessId: 'ALMA_LIFESTYLE',
  personalMode: false,
  activeGroups: ['erp', 'finance', 'staff'],
  pinnedMemories: [{ id: 'p1', content: 'owner prefers concise Bangla', scope: 'personal' }],
}

/** What core.ts ships as `system:` — stable blocks only (volatile is excluded). */
function systemBlocksFor(args: BuildSystemPromptArgs): Anthropic.Messages.TextBlockParam[] {
  return buildSystemPromptBlocks(args).stable
}

function volatileTextFor(args: BuildSystemPromptArgs): string {
  return buildSystemPromptBlocks(args).volatile.map((b) => b.text).join('\n')
}

/** Recursively drop cache_control markers — they are positioning metadata, not
 * part of the content Anthropic hashes for a cache match. */
function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCacheControl) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue
      out[k] = stripCacheControl(v)
    }
    return out as T
  }
  return value
}

describe('B1 — system block is byte-stable across turns', () => {
  it('two turns with DIFFERENT per-turn context produce an IDENTICAL system block', () => {
    const turnA: BuildSystemPromptArgs = {
      ...BASE,
      salahContext: { pendingWaqts: [{ waqt: 'Asr', isOverdue: true, isMissed: false }] },
      businessSnapshot: { text: 'SENTINEL_SNAPSHOT_A sales 5', date: '2026-06-21', isToday: true },
      relevantMemories: [{ id: 'm1', content: 'SENTINEL_MEM_A black abaya restocked', scope: 'business', score: 0.9 }],
    }
    const turnB: BuildSystemPromptArgs = {
      ...BASE,
      salahContext: { pendingWaqts: [{ waqt: 'Maghrib', isOverdue: false, isMissed: false }] },
      businessSnapshot: { text: 'SENTINEL_SNAPSHOT_B sales 9', date: '2026-06-21', isToday: true },
      relevantMemories: [{ id: 'm2', content: 'SENTINEL_MEM_B eid campaign idea', scope: 'business', score: 0.8 }],
    }

    const sysA = systemBlocksFor(turnA)
    const sysB = systemBlocksFor(turnB)

    // THE fix: identical system bytes despite different per-turn context.
    expect(JSON.stringify(sysA)).toEqual(JSON.stringify(sysB))

    // And the per-turn context really did differ (otherwise the test is vacuous).
    expect(volatileTextFor(turnA)).not.toEqual(volatileTextFor(turnB))

    // The volatile data must NOT leak into the system block (unique sentinels so
    // there are no incidental substring collisions with the static prompt).
    const sysText = sysA.map((b) => b.text).join('\n')
    expect(sysText).not.toContain('SENTINEL_SNAPSHOT_A')
    expect(sysText).not.toContain('SENTINEL_MEM_A')
    // …and the sentinels DO appear in the volatile text that moves to the user turn.
    expect(volatileTextFor(turnA)).toContain('SENTINEL_SNAPSHOT_A')
    expect(volatileTextFor(turnA)).toContain('SENTINEL_MEM_A')
  })

  it('playbook + pinned changing between turns do NOT rewrite the system block', () => {
    // The cost regression: getActivePlaybook orders by confidence desc and
    // bumpPlaybookForTool mutates confidence/timesApplied after tool calls, so the
    // playbook list (and order) shifts turn-to-turn; pinned rows also change as the
    // owner pins/unpins. While these lived in the cache_control'd stable block, any
    // such change rewrote the whole prefix (expensive cache-WRITE every turn). They
    // now ride the per-turn volatile block, so the system prefix is byte-stable.
    const turnA: BuildSystemPromptArgs = {
      ...BASE,
      activePlaybook: [
        { id: 'pb1', domain: 'pricing', heuristic: 'PB_RULE_ONE keep margin', confidence: 0.9, timesApplied: 5 },
        { id: 'pb2', domain: 'cs', heuristic: 'PB_RULE_TWO reply fast', confidence: 0.7, timesApplied: 3 },
      ],
      pinnedMemories: [{ id: 'p1', content: 'PIN_ALPHA owner prefers concise', scope: 'personal' }],
    }
    const turnB: BuildSystemPromptArgs = {
      ...BASE,
      // reordered (confidence bump) AND a new rule appeared
      activePlaybook: [
        { id: 'pb2', domain: 'cs', heuristic: 'PB_RULE_TWO reply fast', confidence: 0.95, timesApplied: 4 },
        { id: 'pb1', domain: 'pricing', heuristic: 'PB_RULE_ONE keep margin', confidence: 0.9, timesApplied: 5 },
        { id: 'pb3', domain: 'stock', heuristic: 'PB_RULE_THREE reorder early', confidence: 0.6, timesApplied: 1 },
      ],
      pinnedMemories: [{ id: 'p2', content: 'PIN_BETA eid campaign live', scope: 'business' }],
    }

    const sysA = systemBlocksFor(turnA)
    const sysB = systemBlocksFor(turnB)

    // THE cost fix: identical system bytes despite different playbook + pinned.
    expect(JSON.stringify(sysA)).toEqual(JSON.stringify(sysB))

    // The playbook/pinned content must NOT be in the system block at all…
    const sysText = sysA.map((b) => b.text).join('\n')
    for (const sentinel of ['PB_RULE_ONE', 'PB_RULE_TWO', 'PB_RULE_THREE', 'PIN_ALPHA', 'PIN_BETA']) {
      expect(sysText).not.toContain(sentinel)
    }
    // …it rides the per-turn volatile block instead.
    expect(volatileTextFor(turnA)).toContain('PB_RULE_ONE')
    expect(volatileTextFor(turnA)).toContain('PIN_ALPHA')
    expect(volatileTextFor(turnB)).toContain('PB_RULE_THREE')
    expect(volatileTextFor(turnB)).toContain('PIN_BETA')
  })
})

describe('B1 — conversation-history prefix is byte-stable across consecutive turns', () => {
  it('only the current owner turn carries volatile; history bytes are identical', () => {
    const u1: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'আজকের সেল কত?' }] }
    const a1: Anthropic.Messages.MessageParam = { role: 'assistant', content: [{ type: 'text', text: 'আজ ৫টা সেল বস।' }] }
    const u2: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'pending কয়টা?' }] }
    const a2: Anthropic.Messages.MessageParam = { role: 'assistant', content: [{ type: 'text', text: '২টা pending।' }] }
    const u3: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'stock check koro' }] }

    // Turn N: history [u1, a1] + current owner turn u2.
    const turnN = buildTurnApiMessages([u1, a1, u2], 2, 'VOLATILE_FOR_TURN_N')
    // Turn N+1: u2/a2 are now history; u3 is the new current owner turn.
    const turnN1 = buildTurnApiMessages([u1, a1, u2, a2, u3], 4, 'VOLATILE_FOR_TURN_N1')

    // History prefix [u1, a1] must be byte-identical (content, ignoring the
    // cache_control marker that moves between turns). This identical prefix is
    // exactly what lets the history cache breakpoint HIT on turn N+1.
    expect(stripCacheControl(turnN.slice(0, 2))).toEqual(stripCacheControl(turnN1.slice(0, 2)))
    // u2 is identical in both (clean in turn N+1 history; volatile-injected only
    // when it was the current turn) — its CONTENT in history carries no volatile.
    expect(stripCacheControl(turnN1[2])).toEqual(u2)

    // Volatile appears ONLY in the current owner turn, never in history.
    const currentN = JSON.stringify(turnN[2])
    expect(currentN).toContain('VOLATILE_FOR_TURN_N')
    expect(JSON.stringify(turnN.slice(0, 2))).not.toContain('VOLATILE_FOR_TURN_N')

    const currentN1 = JSON.stringify(turnN1[4])
    expect(currentN1).toContain('VOLATILE_FOR_TURN_N1')
    expect(JSON.stringify(turnN1.slice(0, 4))).not.toContain('VOLATILE')
  })

  it('places ≤4 cache breakpoints with the right anchors mid tool-loop', () => {
    const u1: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'q' }] }
    const a1: Anthropic.Messages.MessageParam = { role: 'assistant', content: [{ type: 'text', text: 'a' }] }
    const u2: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'owner turn' }] }
    // Mid tool-loop: an assistant tool_use + a tool_result user message appended.
    const aTool: Anthropic.Messages.MessageParam = { role: 'assistant', content: [{ type: 'text', text: 'calling tool' }] }
    const uToolResult: Anthropic.Messages.MessageParam = { role: 'user', content: [{ type: 'text', text: 'tool result' }] }

    const out = buildTurnApiMessages([u1, a1, u2, aTool, uToolResult], 2, 'VOL')

    const hasCC = (m: Anthropic.Messages.MessageParam) =>
      Array.isArray(m.content) && m.content.some((b) => 'cache_control' in (b as object))

    // a1 = last prior assistant (history breakpoint)
    expect(hasCC(out[1])).toBe(true)
    // u2 = owner turn: carries volatile, but NO breakpoint mid-loop. A 3rd
    // message breakpoint here would blow the budget — system (1) + tools (1) +
    // 3 messages = 5 → "Found 5" 400. It only earns a breakpoint when it is also
    // the last message (first iteration), which is covered by other tests.
    expect(hasCC(out[2])).toBe(false)
    expect(JSON.stringify(out[2])).toContain('VOL')
    // uToolResult = latest message (within-turn tool-exchange breakpoint)
    expect(hasCC(out[4])).toBe(true)
    // u1 (plain history) and aTool (not the last) get no breakpoint
    expect(hasCC(out[0])).toBe(false)
    expect(hasCC(out[3])).toBe(false)

    // At most 2 MESSAGE breakpoints. With the system block (1) + the tool list
    // (1), the request total stays within the API's hard max of 4 cache_control
    // blocks. (The old code allowed 3 here → 5 total → 400 on multi-tool turns.)
    const totalBreakpoints = out.filter(hasCC).length
    expect(totalBreakpoints).toBeLessThanOrEqual(2)
  })
})

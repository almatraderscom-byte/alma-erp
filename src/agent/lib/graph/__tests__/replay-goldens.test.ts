/**
 * LG-8 — routing replay goldens.
 *
 * The roadmap's replay suite, CI-shaped: every recorded incident input from
 * the LangGraph rollout (2026-07-15/16 preview sessions) replays through the
 * THREE deterministic deciders TOGETHER — head fast-path, routine READ
 * detection, expense WRITE detection — and must keep producing exactly the
 * routing that was verified live. A regression in any regex/priority shows up
 * here before the owner ever sees it (checkpoint-fork replay against the real
 * DB stays out of CI by design — these goldens are the offline half).
 *
 * RULE: never edit an EXPECTATION to make a failure pass — a failed golden is
 * a behavior change that needs the same scrutiny as the original incident.
 */
import { describe, it, expect } from 'vitest'
import { classifyHeadFastPath } from '@/agent/lib/models/head-router'
import { detectRoutineIntent } from '@/agent/lib/graph/routine-turn-graph'
import { detectExpenseAction } from '@/agent/lib/graph/action-turn-graph'

type Golden = {
  text: string
  fastPath: ReturnType<typeof classifyHeadFastPath>
  routine: ReturnType<typeof detectRoutineIntent>
  expenseLog: boolean
  note: string
}

const GOLDENS: Golden[] = [
  // ── verified live on preview, 2026-07-15/16 ──
  { text: 'aj koto sale holo', fastPath: 'routine_kw', routine: 'sales_today', expenseLog: false, note: 'LG-0 launch case (Σ~333 tokens vs ~50k)' },
  { text: 'aj koto khoroch holo', fastPath: 'routine_kw', routine: 'expense_today', expenseLog: false, note: 'LG-1 expense READ, verified Σ267/$0.0000' },
  { text: '500 taka khoroch holo lunch e', fastPath: 'routine_kw', routine: null, expenseLog: true, note: 'LG-3 write pilot — READ intent must NOT claim it' },
  { text: 'ke ke office e ase', fastPath: 'routine_kw', routine: 'attendance', expenseLog: false, note: 'word-boundary fix class (2026-07-14)' },
  // ≤44 chars → the sticky-continuation fast path fires live; the point of the
  // golden is that attendance/routine must NOT claim it.
  { text: 'notun design keno late hocche? karon ase?', fastPath: 'continuation', routine: null, expenseLog: false, note: 'ke/ase INSIDE words must not hit attendance' },
  // ── the 2026-07-16 duplicate-card incident: continuation directive text ──
  {
    text: '[সিস্টেম নোট — Boss approve করেছেন] একটা pending কাজ Boss approve করেছেন এবং সেটা সম্পন্ন হয়েছে: "খরচ: ৳500 — khoroch holo lunch e"। এখন থেমে যেও না — তোমার চলমান কাজের পরের ধাপে নিজে থেকে এগোও।',
    fastPath: null,
    routine: null,
    expenseLog: false,
    note: 'continuation directives must never re-detect (length + guards); graphs additionally skip internal turns entirely',
  },
  // ── money/destructive safety ──
  { text: 'salary ta refund koro', fastPath: 'deny_kw', routine: null, expenseLog: false, note: 'deny beats everything' },
  { text: 'ei mash e koto khoroch holo', fastPath: 'continuation', routine: null, expenseLog: false, note: 'period query — today-window tool must not answer' },
  { text: 'gotokal 500 taka khoroch holo', fastPath: 'routine_kw', routine: null, expenseLog: false, note: 'history date stays with the model loop (date choice)' },
  { text: 'order 1234 er status ki', fastPath: 'routine_kw', routine: 'order_status', expenseLog: false, note: 'LG-1 slot-fill intent' },
  { text: 'order status ki', fastPath: 'continuation', routine: null, expenseLog: false, note: 'no number → model loop judgement' },
]

describe('LG-8 routing replay goldens (recorded incidents)', () => {
  for (const g of GOLDENS) {
    it(`${g.note}: "${g.text.slice(0, 60)}"`, () => {
      expect(classifyHeadFastPath(g.text)).toBe(g.fastPath)
      expect(detectRoutineIntent(g.text)).toBe(g.routine)
      expect(detectExpenseAction(g.text) !== null).toBe(g.expenseLog)
    })
  }
})

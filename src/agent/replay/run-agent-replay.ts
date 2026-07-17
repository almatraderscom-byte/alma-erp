/**
 * Phase 31 replay runner — executes the REAL router/context/state decision
 * code over the fixture corpus with fake external effects.
 *
 * What runs for real (no simulation):
 *   - classifyHeadFastPath        (head-router: deny/call/personal/marketing/routine/continuation)
 *   - isContinuationText          (state-router: short-confirmation detection)
 *   - detectRoutineIntent         (routine-turn-graph: the 9 deterministic read intents)
 *   - matchIntentPacks/packsForPendingActionType (state-router: tool pack selection)
 *   - shouldInjectResumeBrief     (resume-brief: 6h-gap rule)
 *   - shouldAutoContinueTurn      (continuation-policy: deadline salvage)
 *   - resolveHeadModelId          (full head decision — ONLY when the caller injects it,
 *                                  i.e. the vitest layer where prisma/openai are mocked
 *                                  to return the fixture's declared fakes)
 *   - runTurnGraphShadow          (LangGraph shadow graph — Layer B, after head resolution)
 *
 * Binding derivation: current production code has NO deterministic focus
 * resolver (that is exactly what Phase 32 builds). `deriveCurrentBinding`
 * below TRANSCRIBES the deterministic binding gates that exist in
 * run-owner-turn.ts today (reply→card match; workflowRuns + isContinuationText
 * → workflow continuation; listen-mode suppression) and treats everything
 * else as model judgment ('new_task' on a fresh pack hit, else 'none').
 * Failures against expect2.binding are BASELINE FINDINGS — they quantify the
 * "forgot after 2–3 replies" class — and must be reported, never patched by
 * weakening the expectation (roadmap Phase 31 exit gate).
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { validateReplayCase } from './replay-case'
import {
  BEHAVIOR_ARTIFACT_VERSION,
  REPLAY_CATEGORIES,
  replayTraceId,
  validateReplayCaseV2,
  type ReplayCaseResult,
  type ReplayCaseV2,
  type ReplayCategory,
  type ReplayCategoryMetrics,
  type ReplayCheckOutcome,
  type ReplayReport,
} from './replay-types'
import { classifyHeadFastPath, type HeadDecision } from '@/agent/lib/models/head-router'
import { isContinuationText, matchIntentPacks, packsForPendingActionType, type PackKey } from '@/agent/tools/state-router'
import { detectRoutineIntent } from '@/agent/lib/graph/routine-turn-graph'
import { shouldInjectResumeBrief } from '@/agent/lib/resume-brief'
import { shouldAutoContinueTurn } from '@/agent/lib/continuation-policy'

/** Fixed "now" for deterministic replay (matches fixtures' turnAt). */
export const REPLAY_NOW = new Date('2026-07-17T10:00:00+06:00')

export type ResolveHeadFn = (opts: {
  requestedModelId?: string | null
  lastUserText: string
  personalMode: boolean
  businessId: 'ALMA_LIFESTYLE'
  conversationId?: string
}) => Promise<HeadDecision>

export interface ReplayDeps {
  now?: Date
  /**
   * The REAL resolveHeadModelId, injected by the vitest layer where its
   * external effects (prisma sticky lookup, OpenRouter classifiers) are
   * mocked to serve each fixture's `fakes`. When absent (pure CLI layer),
   * head-tier/listen checks are recorded as skipped, never guessed.
   */
  resolveHead?: ResolveHeadFn
}

export type Binding = 'active_workflow' | 'pending_card' | 'checkpoint' | 'new_task' | 'none'

/**
 * Transcription of the deterministic binding gates production code has TODAY
 * (see module doc). Listen suppression uses the fixture's fake classifier
 * verdict — the same value the mocked classifier returns in Layer B.
 */
export function deriveCurrentBinding(c: ReplayCaseV2): Binding {
  const text = c.latestMessage
  const listenConfirmed =
    c.fakes?.personalClassification === 'personal' && classifyHeadFastPath(text) === 'personal_hint'
  if (listenConfirmed) return 'none'
  if (c.replyTo && c.context?.pendingCard && c.replyTo.id === c.context.pendingCard.id) {
    return 'pending_card'
  }
  if (c.context?.activeWorkflow && isContinuationText(text)) return 'active_workflow'
  const packs = matchIntentPacks(text)
  if (packs.length > 0 && !isContinuationText(text)) return 'new_task'
  return 'none'
}

/** Pack selection as the live turn sees it: card-type packs ∪ text packs. */
export function derivePacks(c: ReplayCaseV2): PackKey[] {
  const fromText = matchIntentPacks(c.latestMessage)
  const cardType = c.context?.pendingCard?.actionType
  const fromCard = cardType ? packsForPendingActionType(cardType) : []
  const out: PackKey[] = []
  for (const p of [...fromCard, ...fromText]) if (!out.includes(p)) out.push(p)
  return out
}

function check(name: string, expected: unknown, actual: unknown): ReplayCheckOutcome {
  const pass = Array.isArray(expected)
    ? (expected as unknown[]).every((e) => (actual as unknown[]).includes(e))
    : expected === actual
  return { check: name, expected, actual, pass }
}

/** Run one fixture through the real decision code. */
export async function replayDecisionTurn(c: ReplayCaseV2, deps: ReplayDeps = {}): Promise<ReplayCaseResult> {
  const now = deps.now ?? REPLAY_NOW
  const e = c.expect2
  const checks: ReplayCheckOutcome[] = []
  const skipped: string[] = []
  const text = c.latestMessage

  if (e.fastPath !== undefined) {
    checks.push(check('fastPath', e.fastPath, classifyHeadFastPath(text)))
  }
  if (e.continuationText !== undefined) {
    checks.push(check('continuationText', e.continuationText, isContinuationText(text)))
  }
  if (e.routineIntent !== undefined) {
    checks.push(check('routineIntent', e.routineIntent, detectRoutineIntent(text)))
  }
  if (e.packs !== undefined || e.forbiddenPacks !== undefined) {
    const actualPacks = derivePacks(c)
    if (e.packs !== undefined) {
      checks.push(check('packs⊇', e.packs, actualPacks))
    }
    if (e.forbiddenPacks !== undefined) {
      const violation = e.forbiddenPacks.filter((p) => actualPacks.includes(p as PackKey))
      checks.push({ check: 'packs∌', expected: [], actual: violation, pass: violation.length === 0 })
    }
  }
  if (e.resumeBrief !== undefined) {
    const gap = c.context?.gapMinutes
    const lastAt = gap === undefined ? null : new Date(now.getTime() - gap * 60_000)
    checks.push(check('resumeBrief', e.resumeBrief, shouldInjectResumeBrief(lastAt, now)))
  }
  if (e.autoContinue !== undefined) {
    const t = c.context?.turnOutcome
    if (!t) {
      skipped.push('autoContinue (no turnOutcome in fixture)')
    } else {
      checks.push(check('autoContinue', e.autoContinue, shouldAutoContinueTurn(t)))
    }
  }
  if (e.binding !== undefined) {
    checks.push(check('binding', e.binding, deriveCurrentBinding(c)))
  }

  // Layer B: full head decision through the REAL resolveHeadModelId.
  if (e.headTier !== undefined || e.listenSuppressed !== undefined) {
    if (!deps.resolveHead) {
      if (e.headTier !== undefined) skipped.push('headTier (resolveHead not injected)')
      if (e.listenSuppressed !== undefined) skipped.push('listenSuppressed (resolveHead not injected)')
    } else {
      const d = await deps.resolveHead({
        requestedModelId: null,
        lastUserText: text,
        personalMode: false,
        businessId: 'ALMA_LIFESTYLE',
        conversationId: `replay-${c.id}`,
      })
      if (e.headTier !== undefined) checks.push(check('headTier', e.headTier, d.tier))
      if (e.listenSuppressed !== undefined) {
        // run-owner-turn.ts: `const listenMode = headTier === 'personal'`
        checks.push(check('listenSuppressed', e.listenSuppressed, d.tier === 'personal'))
      }
    }
  }

  const failed = checks.filter((x) => !x.pass).map((x) => x.check)
  return {
    id: c.id,
    category: c.category,
    traceId: replayTraceId(c.id),
    behaviorVersion: BEHAVIOR_ARTIFACT_VERSION,
    checks,
    pass: failed.length === 0,
    failed,
    skipped,
  }
}

// ── Corpus loading ───────────────────────────────────────────────────────────

export function loadCorpus(fixturesDir: string): { cases: ReplayCaseV2[]; errors: string[] } {
  const errors: string[] = []
  const cases: ReplayCaseV2[] = []
  for (const f of readdirSync(fixturesDir).sort()) {
    if (!f.endsWith('.json')) continue
    const raw = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as ReplayCaseV2
    // Phase 0 fixtures (no category) are kept but not part of the v2 corpus.
    if ((raw as { category?: unknown }).category === undefined) continue
    const v1 = validateReplayCase(raw)
    const v2 = validateReplayCaseV2(raw)
    for (const err of [...v1, ...v2]) errors.push(`${f}: ${err}`)
    cases.push(raw)
  }
  return { cases, errors }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function accuracyOf(results: ReplayCaseResult[], checkName: string): number | null {
  let pass = 0
  let total = 0
  for (const r of results) {
    for (const c of r.checks) {
      if (c.check === checkName) {
        total += 1
        if (c.pass) pass += 1
      }
    }
  }
  return total === 0 ? null : pass / total
}

export function buildReport(results: ReplayCaseResult[], cases: ReplayCaseV2[]): ReplayReport {
  const categories: ReplayCategoryMetrics[] = []
  for (const cat of Object.keys(REPLAY_CATEGORIES) as ReplayCategory[]) {
    const rs = results.filter((r) => r.category === cat)
    const byCheck: Record<string, { pass: number; total: number }> = {}
    for (const r of rs) {
      for (const c of r.checks) {
        byCheck[c.check] ??= { pass: 0, total: 0 }
        byCheck[c.check].total += 1
        if (c.pass) byCheck[c.check].pass += 1
      }
    }
    categories.push({
      category: cat,
      cases: rs.length,
      passed: rs.filter((r) => r.pass).length,
      failed: rs.filter((r) => !r.pass).length,
      byCheck,
    })
  }

  // Pack recall = expected packs found; pack precision — a case-level proxy:
  // forbidden-pack violations are the measurable precision failures today.
  const packRecall = accuracyOf(results, 'packs⊇')
  const packPrecision = accuracyOf(results, 'packs∌')

  const byId = new Map(cases.map((c) => [c.id, c]))
  let repeatedEffectRiskCount = 0
  for (const r of results) {
    const c = byId.get(r.id)
    if (c?.expect2.repeatedEffectRisk && r.failed.includes('binding')) repeatedEffectRiskCount += 1
  }

  return {
    behaviorVersion: BEHAVIOR_ARTIFACT_VERSION,
    generatedAt: REPLAY_NOW.toISOString(),
    totalCases: results.length,
    totalPassed: results.filter((r) => r.pass).length,
    totalFailed: results.filter((r) => !r.pass).length,
    categories,
    metrics: {
      fastPathAccuracy: accuracyOf(results, 'fastPath'),
      headTierAccuracy: accuracyOf(results, 'headTier'),
      routineIntentAccuracy: accuracyOf(results, 'routineIntent'),
      packRecall,
      packPrecision,
      continuationTextAccuracy: accuracyOf(results, 'continuationText'),
      bindingAccuracy: accuracyOf(results, 'binding'),
      resumeBriefAccuracy: accuracyOf(results, 'resumeBrief'),
      listenSuppressionAccuracy: accuracyOf(results, 'listenSuppressed'),
      autoContinueAccuracy: accuracyOf(results, 'autoContinue'),
      repeatedEffectRiskCount,
    },
    unmeasured: [
      'groundedness (needs live model output)',
      'Bangla style / naturalness (needs live model output + human rubric)',
      'latency (needs live infrastructure)',
      'token cost (needs live model usage)',
      'end-to-end effect execution (fixtures replay decisions, not effects)',
    ],
    results,
  }
}

export async function runReplayCorpus(fixturesDir: string, deps: ReplayDeps = {}): Promise<ReplayReport> {
  const { cases, errors } = loadCorpus(fixturesDir)
  if (errors.length > 0) {
    throw new Error(`corpus invalid:\n${errors.join('\n')}`)
  }
  const results: ReplayCaseResult[] = []
  for (const c of cases) {
    results.push(await replayDecisionTurn(c, deps))
  }
  return buildReport(results, cases)
}

// ── HTML report (the phase's diagnostic page — local, preview-only) ─────────

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`
}

export function renderHtmlReport(report: ReplayReport, title = 'ALMA Agent Replay Baseline — Phase 31'): string {
  const rows = report.results
    .map(
      (r) =>
        `<tr class="${r.pass ? 'ok' : 'bad'}"><td>${r.id}</td><td>${r.category}</td><td>${r.traceId}</td>` +
        `<td>${r.pass ? 'PASS' : 'FAIL'}</td><td>${r.failed.join(', ') || '—'}</td><td>${r.skipped.join(', ') || '—'}</td></tr>`,
    )
    .join('\n')
  const cats = report.categories
    .map(
      (c) =>
        `<tr><td>${c.category}</td><td>${c.cases}</td><td>${c.passed}</td><td>${c.failed}</td>` +
        `<td>${Object.entries(c.byCheck)
          .map(([k, v]) => `${k} ${v.pass}/${v.total}`)
          .join(' · ')}</td></tr>`,
    )
    .join('\n')
  const m = report.metrics
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:24px;background:#0d1117;color:#e6edf3}
h1{font-size:20px} h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}
td,th{border:1px solid #30363d;padding:4px 8px;text-align:left}
tr.ok td{background:#0f1c14} tr.bad td{background:#2b1214}
.metric{display:inline-block;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin:4px}
.metric b{display:block;font-size:18px}
.small{color:#8b949e;font-size:12px}
</style></head><body>
<h1>${title}</h1>
<p class="small">behaviorVersion ${report.behaviorVersion} · generatedAt ${report.generatedAt} · ${report.totalCases} cases · ${report.totalPassed} pass / ${report.totalFailed} baseline findings</p>
<div>
<span class="metric"><b>${pct(m.fastPathAccuracy)}</b>fast-path</span>
<span class="metric"><b>${pct(m.headTierAccuracy)}</b>head tier</span>
<span class="metric"><b>${pct(m.routineIntentAccuracy)}</b>routine intent</span>
<span class="metric"><b>${pct(m.packRecall)}</b>pack recall</span>
<span class="metric"><b>${pct(m.packPrecision)}</b>pack precision</span>
<span class="metric"><b>${pct(m.continuationTextAccuracy)}</b>continuation text</span>
<span class="metric"><b>${pct(m.bindingAccuracy)}</b>task binding</span>
<span class="metric"><b>${pct(m.resumeBriefAccuracy)}</b>resume brief</span>
<span class="metric"><b>${pct(m.listenSuppressionAccuracy)}</b>listen suppression</span>
<span class="metric"><b>${pct(m.autoContinueAccuracy)}</b>auto-continue</span>
<span class="metric"><b>${m.repeatedEffectRiskCount}</b>repeated-effect risks</span>
</div>
<h2>Unmeasured in this harness (honest deferral)</h2>
<ul>${report.unmeasured.map((u) => `<li>${u}</li>`).join('')}</ul>
<h2>Per category</h2>
<table><tr><th>category</th><th>cases</th><th>pass</th><th>baseline findings</th><th>per-check</th></tr>${cats}</table>
<h2>All cases</h2>
<table><tr><th>id</th><th>category</th><th>trace</th><th>verdict</th><th>failed checks</th><th>skipped</th></tr>
${rows}
</table></body></html>`
}

// ── CLI: npx tsx src/agent/replay/run-agent-replay.ts [--only rc-...] ────────

const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('run-agent-replay.ts')
if (isCli) {
  const fixturesDir = join(dirname(new URL(import.meta.url).pathname), 'fixtures')
  const outDir = process.argv.includes('--out')
    ? process.argv[process.argv.indexOf('--out') + 1]
    : 'docs/proofs/agent-phase-31'
  runReplayCorpus(fixturesDir)
    .then((report) => {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'replay-baseline.json'), JSON.stringify(report, null, 2))
      writeFileSync(join(outDir, 'replay-baseline.html'), renderHtmlReport(report))
      const m = report.metrics
      console.log(`[replay] ${report.totalCases} cases — ${report.totalPassed} pass, ${report.totalFailed} baseline findings`)
      console.log(`[replay] binding ${pct(m.bindingAccuracy)} · fastPath ${pct(m.fastPathAccuracy)} · routine ${pct(m.routineIntentAccuracy)} · packs R ${pct(m.packRecall)} / P ${pct(m.packPrecision)}`)
      console.log(`[replay] report → ${join(outDir, 'replay-baseline.html')}`)
    })
    .catch((err) => {
      console.error('[replay] failed:', err)
      process.exit(1)
    })
}

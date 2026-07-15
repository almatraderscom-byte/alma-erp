#!/usr/bin/env node
/**
 * Agent behavior baseline report (Roadmap Phase 0 exit gate).
 *
 * Prints the pre-rearchitecture baseline the roadmap's scorecard is measured
 * against: tool-call volume/failure/latency, per-tool hotspots, turn terminal
 * states, and cost per day. Run BEFORE each roadmap phase ships and keep the
 * output with the phase PR so improvement (or regression) is a diff, not a vibe.
 *
 * Usage (needs DATABASE_URL, read-only):
 *   node scripts/agent-baseline-report.mjs --days 14
 */
import { PrismaClient } from '@prisma/client'

const args = process.argv.slice(2)
const i = args.indexOf('--days')
const DAYS = Number(i >= 0 ? args[i + 1] : '14')

async function main() {
  const prisma = new PrismaClient()
  const since = new Date(Date.now() - DAYS * 86400 * 1000)
  const sinceFilter = { gte: since }

  // ── Tool events ────────────────────────────────────────────────────────────
  const events = await prisma.agentToolEvent.findMany({
    where: { ts: sinceFilter },
    select: { toolName: true, success: true, verified: true, errorClass: true, latencyMs: true, phase: true, errorCode: true, detail: true },
  })
  const real = events.filter((e) => e.toolName !== '__refusal__' && (e.phase ?? 'tool') === 'tool')
  const fails = real.filter((e) => !e.success)
  const latencies = real.map((e) => e.latencyMs).sort((a, b) => a - b)
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0

  const byTool = new Map()
  for (const e of real) {
    const t = byTool.get(e.toolName) ?? { calls: 0, fails: 0 }
    t.calls += 1
    if (!e.success) t.fails += 1
    byTool.set(e.toolName, t)
  }
  const byError = new Map()
  for (const e of fails) byError.set(e.errorCode ?? e.errorClass ?? 'unknown', (byError.get(e.errorCode ?? e.errorClass ?? 'unknown') ?? 0) + 1)

  // ── Phase 1 spans ──────────────────────────────────────────────────────────
  const routeSpans = events.filter((e) => e.phase === 'route')
  const toolCounts = routeSpans.map((e) => e.detail?.toolCount ?? 0).sort((a, b) => a - b)
  const toolCountP95 = toolCounts[Math.floor(toolCounts.length * 0.95)] ?? null
  const approvalSpans = events.filter((e) => e.phase === 'approval')
  const approvalByDecision = new Map()
  for (const e of approvalSpans) {
    const d = e.detail?.decision ?? 'unknown'
    approvalByDecision.set(d, (approvalByDecision.get(d) ?? 0) + 1)
  }

  // ── Owner feedback (Phase 1) ───────────────────────────────────────────────
  let feedback = []
  try {
    feedback = await prisma.agentOwnerFeedback.groupBy({
      by: ['kind'],
      where: { ts: sinceFilter },
      _count: { _all: true },
    })
  } catch {
    // table may not exist yet on older DBs
  }

  // ── Turns ──────────────────────────────────────────────────────────────────
  const turns = await prisma.agentTurn.groupBy({
    by: ['status'],
    where: { startedAt: sinceFilter },
    _count: { _all: true },
  })

  // ── Cost ───────────────────────────────────────────────────────────────────
  const msgs = await prisma.agentMessage.aggregate({
    where: { createdAt: sinceFilter, role: 'assistant' },
    _sum: { costUsd: true },
    _count: { _all: true },
  })

  const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) + '%' : 'n/a')
  console.log(`\n=== Agent baseline — last ${DAYS} days (since ${since.toISOString().slice(0, 10)}) ===\n`)
  console.log(`Tool calls: ${real.length}  fail ${fails.length} (${pct(fails.length, real.length)})  p95 latency ${p95}ms`)
  console.log(`verified=true: ${real.filter((e) => e.verified).length} (${pct(real.filter((e) => e.verified).length, real.length)})  ← roadmap: should come from proof logic, today ~never set`)
  console.log(`refusal events (__refusal__): ${events.length - real.length}`)
  console.log('\nTop error classes:')
  for (const [cls, n] of [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${cls}: ${n}`)
  console.log('\nTop 15 tools by calls:')
  for (const [name, t] of [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 15)) {
    console.log(`  ${name}: ${t.calls} calls, ${t.fails} fails`)
  }
  console.log('\nTurn terminal states:')
  for (const t of turns) console.log(`  ${t.status}: ${t._count._all}`)
  const cost = msgs._sum.costUsd ? Number(msgs._sum.costUsd) : 0
  console.log(`\nAssistant messages: ${msgs._count._all}  total cost $${cost.toFixed(2)}  ($${(cost / DAYS).toFixed(2)}/day)`)

  console.log('\n── Phase 1 spans ──')
  console.log(`Route spans: ${routeSpans.length}  exposed-tool count p95: ${toolCountP95 ?? 'n/a'}`)
  console.log(`Approval decisions: ${[...approvalByDecision.entries()].map(([d, n]) => `${d} ${n}`).join(' · ') || 'none'}`)
  console.log(`Owner feedback: ${feedback.length ? feedback.map((f) => `${f.kind} ${f._count._all}`).join(' · ') : 'none yet'}`)
  console.log('\nStill needs later phases: duplicate-action detection, restart-from-zero rate (Phase 4 WorkflowRun).')
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

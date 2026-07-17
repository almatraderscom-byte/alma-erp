/**
 * Roadmap 1 Phase 35 — durable long specialist work on the VPS queue.
 *
 * Jobs over ~30s never run on Vercel functions (project rule) — they land
 * here with the full durable-run contract:
 *   - CHECKPOINT/RESUME: progress ({completed briefs + findings}) persists
 *     after EVERY brief; a crashed/retried job skips completed briefs — no
 *     duplicated work, ever.
 *   - HEARTBEAT: stamped before each brief so a stuck job is visible.
 *   - CANCELLATION: checked between briefs (owner cancelled the card).
 *   - DEADLINE: a soft budget; hitting it checkpoints the remainder and
 *     returns 'partial' so a follow-up job finishes the tail.
 *   - DEDUPE: BullMQ jobId = pendingActionId upstream, plus the completed-set
 *     skip here (belt and braces).
 *
 * Pure orchestration with injected effects — worker/index.mjs wires the real
 * runBrief/persistence; the __tests__ file drives crash/retry/cancel/deadline.
 */

/**
 * @param {object} deps
 * @param {(brief: object) => Promise<{success: boolean, summary: string, error?: string}>} deps.runBrief
 * @param {(progress: object) => Promise<void>} deps.saveProgress
 * @param {() => Promise<object|null>} deps.loadProgress
 * @param {() => Promise<void>} deps.heartbeat
 * @param {() => Promise<boolean>} deps.isCancelled
 * @param {number} [deps.deadlineMs]
 * @param {() => number} [deps.now]
 */
export function createAgentGraphRunner(deps) {
  const deadlineMs = deps.deadlineMs ?? 25 * 60_000
  const now = deps.now ?? (() => Date.now())

  /**
   * @param {{briefs: Array<object>}} payload
   * @returns {Promise<{status: 'done'|'partial'|'cancelled', findings: Array<object>, resumedFrom: number, remaining: number}>}
   */
  return async function runAgentGraphJob(payload) {
    const briefs = Array.isArray(payload?.briefs) ? payload.briefs : []
    const prior = (await deps.loadProgress()) ?? { completed: [], findings: [] }
    const completed = new Set(prior.completed ?? [])
    const findings = [...(prior.findings ?? [])]
    const resumedFrom = completed.size
    const startedAt = now()

    for (let i = 0; i < briefs.length; i++) {
      if (completed.has(i)) continue // resume: already-verified work never re-runs

      if (await deps.isCancelled()) {
        await deps.saveProgress({ completed: [...completed], findings, status: 'cancelled' })
        return { status: 'cancelled', findings, resumedFrom, remaining: briefs.length - completed.size }
      }
      if (now() - startedAt > deadlineMs) {
        await deps.saveProgress({ completed: [...completed], findings, status: 'deadline_checkpoint' })
        return { status: 'partial', findings, resumedFrom, remaining: briefs.length - completed.size }
      }

      await deps.heartbeat()
      let finding
      try {
        const r = await deps.runBrief(briefs[i])
        finding = { index: i, role: briefs[i]?.role ?? 'unknown', success: r.success !== false, summary: r.summary ?? '', error: r.error ?? null }
      } catch (err) {
        // A failed brief is VISIBLE and final for this run; siblings continue.
        finding = { index: i, role: briefs[i]?.role ?? 'unknown', success: false, summary: '', error: err?.message ?? String(err) }
      }
      findings.push(finding)
      completed.add(i)
      // Checkpoint after EVERY brief — the crash window can only lose the
      // brief in flight, and its re-run is exactly the resume contract.
      await deps.saveProgress({ completed: [...completed], findings, status: 'running' })
    }

    await deps.saveProgress({ completed: [...completed], findings, status: 'done' })
    return { status: 'done', findings, resumedFrom, remaining: 0 }
  }
}

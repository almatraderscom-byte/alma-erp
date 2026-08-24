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

class RetryableSpecialistBriefError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RetryableSpecialistBriefError'
    this.retryable = true
  }
}

/**
 * Invoke one specialist brief by durable identity only. The app owns binding,
 * exact-once claim and server-side rendering from AgentPendingAction.payload.
 * A duplicate/lost-response observer may settle only from the exact linked
 * assistant row; running or row-lag observations remain retryable.
 */
export async function runSourceBoundSpecialistBrief({
  pendingActionId,
  briefIndex,
  appUrl,
  token,
  fetchImpl = fetch,
}) {
  let res
  try {
    res = await fetchImpl(`${String(appUrl).replace(/\/$/, '')}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        internalControl: true,
        continuationSource: {
          kind: 'specialist_brief',
          pendingActionId,
          briefIndex,
        },
      }),
      signal: AbortSignal.timeout(5 * 60_000),
    })
  } catch {
    // Never include network exception text: request metadata may contain an
    // internal URL or credential-bearing context.
    throw new RetryableSpecialistBriefError('specialist_continuation_transport')
  }

  const data = await res.json().catch(() => ({}))
  if (res.status === 202) {
    const text = typeof data?.text === 'string' ? data.text.trim() : ''
    if (data?.observe === true && data?.status === 'done' && text) {
      return { success: true, summary: text }
    }
    if (data?.status === 'running') {
      throw new RetryableSpecialistBriefError('specialist_continuation_running')
    }
    if (data?.status === 'done' && !text) {
      throw new RetryableSpecialistBriefError('specialist_terminal_text_unavailable')
    }
    return {
      success: false,
      summary: '',
      error: `specialist_continuation_${String(data?.status ?? 'observe_invalid')}`,
    }
  }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableSpecialistBriefError(`specialist_chat_http_${res.status}`)
    }
    return { success: false, summary: '', error: `specialist_chat_http_${res.status}` }
  }

  const summary = typeof data?.reply === 'string'
    ? data.reply.trim()
    : typeof data?.text === 'string' ? data.text.trim() : ''
  return {
    success: Boolean(summary),
    summary,
    ...(summary ? {} : { error: 'empty_reply' }),
  }
}

/**
 * @param {object} deps
 * @param {(brief: object, index: number) => Promise<{success: boolean, summary: string, error?: string}>} deps.runBrief
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
        const r = await deps.runBrief(briefs[i], i)
        finding = { index: i, role: briefs[i]?.role ?? 'unknown', success: r.success !== false, summary: r.summary ?? '', error: r.error ?? null }
      } catch (err) {
        // Transport loss / a still-running exact duplicate is not a terminal
        // finding. Abort this BullMQ attempt without checkpointing the brief;
        // the next attempt observes the same deterministic continuation.
        if (err?.retryable === true) throw err
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

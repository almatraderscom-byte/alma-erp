/**
 * Replay cases (Roadmap Phase 0 — AGENT-EVAL-001).
 *
 * A replay case is one real (anonymized) owner turn converted into a fixture:
 * what the owner said, what the agent should have done (intent, tools, workflow
 * transition, approval, outcome) and — for incident-born cases — what it did
 * wrong. The suite is the permanent regression net the roadmap requires: every
 * future behavior fix must add or update a case here FIRST, and CI replays the
 * suite so a prompt/router/tool change that re-breaks an old incident fails
 * before it ships.
 *
 * Fixtures live in src/agent/replay/fixtures/*.json (one case per file) and are
 * format-validated by __tests__/replay-fixtures.test.ts. Export new cases from
 * real conversations with scripts/export-replay-cases.ts.
 */

export type ReplayTranscriptEntry = {
  role: 'owner' | 'agent' | 'tool'
  /** Anonymized text (or tool name + short result summary for role 'tool'). */
  text: string
}

export type ReplayExpectation = {
  /** One-line intent label, e.g. 'resume_blocked_post_approval', 'staff_task_dispatch'. */
  intent: string
  /** Tool groups the router should select (subset match). */
  toolGroups?: string[]
  /** Tools the head is expected to call (subset, order-insensitive). */
  tools?: string[]
  /** Tools that must NOT be called (e.g. re-navigation, duplicate card staging). */
  forbiddenTools?: string[]
  /** Expected workflow transition once the Phase 4 WorkflowRun engine lands. */
  workflow?: { kind: string; from?: string; to?: string }
  /** True when the correct behavior is to stage an approval card and stop. */
  approvalRequired?: boolean
  /** Plain-language description of the correct final outcome. */
  outcome: string
}

export type ReplayCase = {
  /** Stable slug: rc-<nnnn>-<short-kebab-title>. Never reuse. */
  id: string
  /** Anonymized pointer back to the source turn (for humans; no PII). */
  source: { conversationId: string; turnAt: string }
  /** What this case protects: the incident or behavior in plain language. */
  description: string
  /** Trimmed, anonymized conversation leading up to the latest message. */
  transcript: ReplayTranscriptEntry[]
  /** The owner message under test (the turn being replayed). */
  latestMessage: string
  /** Structured reply link when the message answered a card/approval/task. */
  replyTo?: { kind: 'ask_card' | 'approval' | 'checkpoint' | 'open_task'; id: string }
  expected: ReplayExpectation
  /** What the agent actually did when the incident happened (if incident-born). */
  observed?: { tools?: string[]; outcome?: string; failureClass?: string }
  /** Free-form labels: 'wrong-tool', 'lost-progress', 'multi-card', 'browser-detour', … */
  tags: string[]
}

/** Validate a parsed fixture. Returns [] when valid, else human-readable errors. */
export function validateReplayCase(c: unknown): string[] {
  const errors: string[] = []
  if (typeof c !== 'object' || c === null) return ['case is not an object']
  const rc = c as Record<string, unknown>

  if (typeof rc.id !== 'string' || !/^rc-\d{4}-[a-z0-9-]+$/.test(rc.id)) {
    errors.push('id must match rc-<nnnn>-<kebab-title>')
  }
  const src = rc.source as Record<string, unknown> | undefined
  if (!src || typeof src.conversationId !== 'string' || typeof src.turnAt !== 'string') {
    errors.push('source.conversationId and source.turnAt are required strings')
  }
  if (typeof rc.description !== 'string' || rc.description.length < 10) {
    errors.push('description must explain the case (≥10 chars)')
  }
  if (!Array.isArray(rc.transcript)) {
    errors.push('transcript must be an array')
  } else {
    for (const [i, e] of (rc.transcript as unknown[]).entries()) {
      const entry = e as Record<string, unknown>
      if (!entry || !['owner', 'agent', 'tool'].includes(String(entry.role)) || typeof entry.text !== 'string') {
        errors.push(`transcript[${i}] needs role owner|agent|tool and text`)
      }
    }
  }
  if (typeof rc.latestMessage !== 'string' || rc.latestMessage.length === 0) {
    errors.push('latestMessage is required')
  }
  if (rc.replyTo !== undefined) {
    const r = rc.replyTo as Record<string, unknown>
    if (!r || !['ask_card', 'approval', 'checkpoint', 'open_task'].includes(String(r.kind)) || typeof r.id !== 'string') {
      errors.push('replyTo needs kind ask_card|approval|checkpoint|open_task and id')
    }
  }
  const exp = rc.expected as Record<string, unknown> | undefined
  if (!exp || typeof exp !== 'object') {
    errors.push('expected is required')
  } else {
    if (typeof exp.intent !== 'string' || exp.intent.length === 0) errors.push('expected.intent is required')
    if (typeof exp.outcome !== 'string' || exp.outcome.length < 10) errors.push('expected.outcome must describe the correct result (≥10 chars)')
    for (const k of ['toolGroups', 'tools', 'forbiddenTools'] as const) {
      if (exp[k] !== undefined && (!Array.isArray(exp[k]) || (exp[k] as unknown[]).some((v) => typeof v !== 'string'))) {
        errors.push(`expected.${k} must be a string array`)
      }
    }
  }
  if (!Array.isArray(rc.tags) || (rc.tags as unknown[]).some((t) => typeof t !== 'string')) {
    errors.push('tags must be a string array')
  }

  // PII tripwires — fixtures are committed to git, so they must be anonymized.
  const blob = JSON.stringify(c)
  if (/\+?88\s?0?1[3-9]\d{2}[-\s]?\d{6}/.test(blob)) errors.push('possible BD phone number — anonymize before committing')
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(blob)) errors.push('possible email address — anonymize before committing')
  return errors
}

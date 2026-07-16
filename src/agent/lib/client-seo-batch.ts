/** Durable orchestration for one-or-many client SEO targets. */
import { prisma } from '@/lib/prisma'
import {
  CLIENT_SEO_BATCH_KIND,
  clientSeoBatchIsReadyForPack,
  clientSeoBatchRequiredTool,
  clientSeoBatchStateLabel,
  createClientSeoBatchFacts,
  reduceClientSeoBatch,
  type ClientSeoBatchEvent,
  type ClientSeoBatchFacts,
} from './client-seo-batch-state'
import {
  ensureActiveWorkflowRun,
  listActiveWorkflowRuns,
  transitionWorkflowRun,
  WorkflowVersionConflictError,
  type WorkflowRunView,
} from './workflow-run'
import type { OwnerTurnRequirements } from './owner-turn-requirements'
import { extractClientSeoBrowserEvidenceUrl } from './client-seo-browser-evidence'
import { mirrorSeoBatchTransition } from '@/agent/lib/graph/seo-batch-graph'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function asFacts(run: WorkflowRunView): ClientSeoBatchFacts | null {
  const f = run.facts as unknown as ClientSeoBatchFacts | null
  return f?.version === 1 && Array.isArray(f.targets) ? f : null
}

async function activeBatch(conversationId: string): Promise<WorkflowRunView | null> {
  const runs = await listActiveWorkflowRuns(conversationId, 10)
  return runs.find((r) => r.kind === CLIENT_SEO_BATCH_KIND) ?? null
}

export async function ensureClientSeoBatchWorkflow(opts: {
  conversationId: string
  businessId: string
  ownerText: string
  requirements: OwnerTurnRequirements
}): Promise<WorkflowRunView | null> {
  if (!opts.requirements.clientSeo || opts.requirements.targets.length === 0) return null
  const existing = await activeBatch(opts.conversationId)
  if (existing) return existing
  const facts = createClientSeoBatchFacts(opts.requirements.targets, {
    requireLiveBrowser: opts.requirements.liveBrowser,
    requireArtifact: opts.requirements.reportArtifact,
  })
  const run = await ensureActiveWorkflowRun({
    conversationId: opts.conversationId,
    businessId: opts.businessId,
    kind: CLIENT_SEO_BATCH_KIND,
    goal: opts.ownerText.slice(0, 2000),
    state: clientSeoBatchStateLabel(facts),
    facts: facts as unknown as Record<string, unknown>,
    nextAllowedTools: [clientSeoBatchRequiredTool(facts)].filter((x): x is string => Boolean(x)),
  })
  // LG-6 pilot: seed the run's durable graph thread (fail-open, no await-chain
  // risk — the mirror never throws and the run row is already committed).
  if (run) await mirrorSeoBatchTransition({ runId: run.id, facts, event: null })
  return run
}

export async function getClientSeoBatchRequiredTool(conversationId: string): Promise<string | null> {
  const run = await activeBatch(conversationId)
  const facts = run && asFacts(run)
  return facts ? clientSeoBatchRequiredTool(facts) : null
}

export async function getClientSeoBatchStatus(conversationId: string): Promise<{
  run: WorkflowRunView
  facts: ClientSeoBatchFacts
  requiredTool: string | null
} | null> {
  const run = await activeBatch(conversationId)
  const facts = run && asFacts(run)
  return run && facts ? { run, facts, requiredTool: clientSeoBatchRequiredTool(facts) } : null
}

function eventFromTool(toolName: string, input: Record<string, unknown>, data: unknown): ClientSeoBatchEvent | null {
  const d = (data ?? {}) as Record<string, unknown>
  if (toolName === 'live_browser_act') return { type: 'browser_act' }
  if (toolName === 'live_browser_look') {
    const url = extractClientSeoBrowserEvidenceUrl(input, d)
    if (!url) return null
    return {
      type: 'browser_look',
      url,
      ...(typeof d.screenshotUrl === 'string' ? { screenshotUrl: d.screenshotUrl } : {}),
    }
  }
  if (toolName === 'run_website_seo_audit' && typeof d.pendingActionId === 'string') {
    return { type: 'audit_queued', actionId: d.pendingActionId }
  }
  if (toolName === 'check_website_seo_audit' && typeof d.id === 'string') {
    if (input.read === 'report') return { type: 'report_read', actionId: d.id }
    if (input.read === 'links') return { type: 'links_read', actionId: d.id }
  }
  if (toolName === 'complete_skill_pack_run' && d.done === true) return { type: 'pack_completed' }
  return null
}

/** Awaited by the executor: state must land before the model's next round. */
export async function recordClientSeoBatchTool(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
  data: unknown,
): Promise<void> {
  const event = eventFromTool(toolName, input, data)
  if (!event) return
  const run = await activeBatch(conversationId)
  const facts = run && asFacts(run)
  if (!run || !facts) return
  const next = reduceClientSeoBatch(facts, event)
  const required = clientSeoBatchRequiredTool(next)
  const waitingWorker = event.type === 'audit_queued'
  const done = event.type === 'pack_completed' && clientSeoBatchIsReadyForPack(facts)
  try {
    await transitionWorkflowRun({
      runId: run.id,
      expectedVersion: run.stateVersion,
      toStatus: done ? 'done' : waitingWorker ? 'waiting_worker' : 'active',
      toState: done ? 'completed' : clientSeoBatchStateLabel(next),
      facts: next as unknown as Record<string, unknown>,
      nextAllowedTools: required ? [required] : [],
      pendingActionId: event.type === 'audit_queued' ? event.actionId : null,
      cause: 'turn',
      detail: { toolName, event: event.type },
    })
    if (event.type === 'audit_queued') {
      await db.agentPendingAction.update({
        where: { id: event.actionId },
        data: { workflowRunId: run.id },
      }).catch(() => {})
    }
    // LG-6 pilot: mirror the SAME transition into the run's graph thread —
    // node re-runs the reducer from the pre-transition facts, so drift between
    // the engines surfaces in logs. Only after the legacy write succeeded.
    await mirrorSeoBatchTransition({
      runId: run.id,
      facts,
      event,
      legacyStateLabel: done ? 'completed' : clientSeoBatchStateLabel(next),
    })
  } catch (err) {
    if (!(err instanceof WorkflowVersionConflictError)) throw err
  }
}

/** Called by the worker callback before it resumes the owner head. */
export async function recordClientSeoAuditResult(
  run: WorkflowRunView,
  actionId: string,
  ok: boolean,
  cause = 'worker',
): Promise<void> {
  const facts = asFacts(run)
  if (!facts) return
  const next = reduceClientSeoBatch(facts, { type: 'audit_finished', actionId, ok })
  await transitionWorkflowRun({
    runId: run.id,
    expectedVersion: run.stateVersion,
    toStatus: ok ? 'active' : 'failed',
    toState: clientSeoBatchStateLabel(next),
    facts: next as unknown as Record<string, unknown>,
    nextAllowedTools: ok ? ['check_website_seo_audit'] : [],
    pendingActionId: ok ? null : actionId,
    cause,
    detail: { actionId, ok },
  })
  // LG-6 pilot: worker-side transitions land on the thread too — the history
  // must show the WHOLE run, not just the turn-driven steps.
  await mirrorSeoBatchTransition({
    runId: run.id,
    facts,
    event: { type: 'audit_finished', actionId, ok },
    legacyStateLabel: clientSeoBatchStateLabel(next),
  })
}

export function clientSeoBatchProgressText(facts: ClientSeoBatchFacts): string {
  const target = facts.targets[facts.currentIndex]
  if (!target) return 'সব target-এর audit/report হয়েছে; এখন final client file completion gate বাকি।'
  if (target.auditStatus === 'queued') {
    return `🔄 ${target.url}-এর technical crawl এখন worker-এ চলছে। Result এলেই server নিজে report পড়ে পরের target-এ যাবে—Boss-এর নতুন message লাগবে না।`
  }
  if (target.auditStatus === 'failed') return `❌ ${target.url}-এর crawl ব্যর্থ হয়েছে; workflow fail-safe অবস্থায় থেমেছে।`
  return `⏳ Ordered SEO কাজ চলমান: target ${facts.currentIndex + 1}/${facts.targets.length} — ${target.url}; পরের ধাপ: ${clientSeoBatchRequiredTool(facts) ?? 'worker result'}.`
}

export async function guardClientSeoBatchTool(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ guard: string; error: string } | null> {
  const status = await getClientSeoBatchStatus(conversationId)
  if (!status) return null
  const { facts, requiredTool } = status
  const target = facts.targets[facts.currentIndex]

  if (toolName === 'complete_skill_pack_run') {
    if (!clientSeoBatchIsReadyForPack(facts)) {
      return { guard: 'client_seo_batch_incomplete', error: `WORKFLOW_BLOCKED: ordered client SEO কাজ অসম্পূর্ণ; পরের বাধ্যতামূলক tool হলো ${requiredTool ?? 'worker result-এর অপেক্ষা'}।` }
    }
    const md = String(input.artifactMarkdown ?? '')
    const missingDomain = facts.targets.find((t) => !md.toLowerCase().includes(new URL(t.url).hostname.toLowerCase()))
    if (missingDomain || (facts.requireLiveBrowser && !/লাইভ\s*ব্রাউজ|live\s*browser/i.test(md))) {
      return { guard: 'client_seo_artifact_missing_proof', error: 'WORKFLOW_BLOCKED: final artifact-এ প্রতিটি target domain এবং “লাইভ ব্রাউজ পর্যবেক্ষণ” evidence section থাকতে হবে।' }
    }
  }

  if (toolName === 'run_website_seo_audit') {
    if (requiredTool !== toolName) return { guard: 'client_seo_browser_proof_first', error: `WORKFLOW_BLOCKED: crawler-এর আগে বর্তমান target-এর live-browser proof শেষ করো; পরের tool ${requiredTool ?? 'worker wait'}।` }
    const requested = String(input.url ?? '')
    try {
      if (target && new URL(requested).hostname.replace(/^www\./, '') !== new URL(target.url).hostname.replace(/^www\./, '')) {
        return { guard: 'client_seo_wrong_target_order', error: `WORKFLOW_BLOCKED: target order ভাঙা যাবে না। এখন ${target.url}; ${requested} পরে।` }
      }
    } catch { /* URL schema validation reports malformed input */ }
  }

  if (toolName === 'check_website_seo_audit' && requiredTool === toolName && target) {
    const expectedRead = target.reportDelivered ? 'links' : 'report'
    if (input.read !== expectedRead) {
      return { guard: 'client_seo_required_read', error: `WORKFLOW_BLOCKED: current audit-এর read:"${expectedRead}" এখন বাধ্যতামূলক; status-only check completion নয়।` }
    }
  }

  // 2026-07-16 incident fix: the browse guard's job is keeping the agent ON
  // the client's sites — not hard-locking it to ONE of them. When a listed
  // domain 301s into another (gulshanspaone → queenspabd), the old
  // current-target-only rule deadlocked every navigation. Any host that
  // matches ANY batch target is legal; unrelated hosts stay blocked.
  const isListedTargetHost = (raw: string): boolean => {
    try {
      const wanted = new URL(raw).hostname.replace(/^www\./, '')
      return facts.targets.some((t) => {
        try { return new URL(t.url).hostname.replace(/^www\./, '') === wanted } catch { return false }
      })
    } catch {
      return true // malformed URL → normal schema validation reports it
    }
  }
  if (toolName === 'live_browser_act' && String(input.action ?? '') === 'navigate' && target) {
    if (!isListedTargetHost(String(input.url ?? ''))) {
      return { guard: 'client_seo_wrong_browser_target', error: `WORKFLOW_BLOCKED: শুধু client-এর listed site গুলোই browse করা যাবে (${facts.targets.map((t) => t.url).join(', ')})।` }
    }
  }
  if (toolName === 'live_browser_look' && typeof input.url === 'string' && target) {
    if (!isListedTargetHost(input.url)) {
      return {
        guard: 'client_seo_wrong_browser_target',
        error: `WORKFLOW_BLOCKED: শুধু client-এর listed site গুলোই browse করা যাবে (${facts.targets.map((t) => t.url).join(', ')})।`,
      }
    }
  }
  return null
}

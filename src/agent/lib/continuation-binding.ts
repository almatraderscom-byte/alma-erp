/**
 * Durable authority for unattended continuation turns.
 *
 * Conversation prose is context, never the identity of an internal task. A
 * binding points at the exact persisted source row and becomes immutable on the
 * AgentTurn. AgentTurn.requestId is the deterministic replay key; a separate
 * one-way claim prevents the inline and worker executors from both running it.
 */
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { AGENT_VERSIONS } from '@/agent/lib/agent-versions'

export type ContinuationOrigin =
  | 'job_result'
  | 'open_task'
  | 'approval'
  | 'self_continue'
  | 'steering'
  | 'job_delivery'
  | 'voice_call'
  | 'mac_proof'
  | 'plan_driver'
  | 'specialist'

export type ContinuationSourceKind =
  | 'pending_action'
  | 'workflow_run'
  | 'open_task'
  | 'turn'
  | 'plan_step'

export type ContinuationDomain =
  | 'seo'
  | 'browser'
  | 'creative'
  | 'calls'
  | 'generic'

export type ContinuationEvent =
  | 'artifact_delivered'
  | 'resume_requested'
  | 'action_executed'
  | 'deadline_resume'
  | 'delivery_retry'
  | 'steering_applied'
  | 'call_terminal'
  | 'visual_proof_ready'
  | 'step_dispatch'
  | 'specialist_dispatch'

export type ContinuationDirectiveKind =
  | 'seo_artifact_delivered'
  | 'image_artifact_delivered'
  | 'open_task_resume'
  | 'approved_action_completed'
  | 'deadline_resume'
  | 'job_delivery_retry'
  | 'owner_steering'
  | 'voice_call_terminal'
  | 'mac_visual_proof'
  | 'plan_step_execute'
  | 'specialist_brief_execute'

export interface ContinuationBindingV1 {
  v: 1
  origin: ContinuationOrigin
  source: { kind: ContinuationSourceKind; id: string }
  conversationId: string
  domain: ContinuationDomain
  event: ContinuationEvent
  workflowRunId?: string
  planId?: string
  /** Stable child identity when one persisted source owns multiple executions. */
  subidentity?: string
  /** Immutable digest of a selected child payload (specialist brief v1). */
  sourceDigest?: string
  /** Exact persisted row proving a deadline turn's workflow/domain context. */
  authorityRef?: {
    kind: 'source_binding' | 'workflow_event' | 'conversation_focus' | 'checkpoint'
    id: string
  }
  directive: { kind: ContinuationDirectiveKind; version: 1 }
  expected: {
    sourceStatus: string[]
    sourceType?: string
    workflowKind?: string
    workflowStateVersion?: number
    deliveryState?: 'delivered' | 'message_delivered'
  }
  modalities?: Array<'chrome'>
  /** Exact durable owner-message rows applied after the predecessor turn ended. */
  steeringMessageIds?: string[]
}

export type LoadedContinuationBinding =
  | { state: 'bound'; binding: ContinuationBindingV1; requestId: string; status: string }
  | { state: 'absent' }
  | { state: 'invalid'; reason: string }

export interface BoundContinuationTurn {
  turnId: string
  requestId: string
  status: string
  created: boolean
}

export type ContinuationExecutionClaim =
  | {
      outcome: 'claimed'
      binding: ContinuationBindingV1
      directive: string
      status: string
    }
  | {
      outcome: 'observe'
      binding: ContinuationBindingV1
      directive?: string
      status: string
    }

type DirectiveContext = {
  openTaskResumeNote?: string
  ownerSteeringPrompt?: string
  planStepDirective?: string
  specialistBriefDirective?: string
}

const ORIGINS = new Set<ContinuationOrigin>([
  'job_result', 'open_task', 'approval', 'self_continue', 'steering',
  'job_delivery', 'voice_call', 'mac_proof', 'plan_driver', 'specialist',
])
const SOURCE_KINDS = new Set<ContinuationSourceKind>([
  'pending_action', 'workflow_run', 'open_task', 'turn', 'plan_step',
])
const DOMAINS = new Set<ContinuationDomain>(['seo', 'browser', 'creative', 'calls', 'generic'])
const EVENTS = new Set<ContinuationEvent>([
  'artifact_delivered', 'resume_requested', 'action_executed', 'deadline_resume',
  'delivery_retry', 'steering_applied', 'call_terminal', 'visual_proof_ready',
  'step_dispatch', 'specialist_dispatch',
])
const DIRECTIVES = new Set<ContinuationDirectiveKind>([
  'seo_artifact_delivered', 'image_artifact_delivered', 'open_task_resume', 'approved_action_completed',
  'deadline_resume', 'job_delivery_retry', 'owner_steering',
  'voice_call_terminal', 'mac_visual_proof',
  'plan_step_execute', 'specialist_brief_execute',
])

export class ContinuationBindingError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code)
    this.name = 'ContinuationBindingError'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

export function sourceBoundContinuationsEnabled(): boolean {
  const raw = (process.env.AGENT_SOURCE_BOUND_CONTINUATIONS ?? '').trim().toLowerCase()
  // Safe default is the source-bound path. Rollback explicitly disables
  // unattended continuation; it never resurrects free-form transcript authority.
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

export function continuationDomainForWorkflowKind(kind: string | null | undefined): ContinuationDomain {
  const normalized = (kind ?? '').trim().toLowerCase()
  if (/seo/.test(normalized)) return 'seo'
  if (/(browser|chrome|youtube|computer)/.test(normalized)) return 'browser'
  if (/(creative|image|video|media|social|product_post|campaign)/.test(normalized)) return 'creative'
  if (/(call|voice|phone)/.test(normalized)) return 'calls'
  return 'generic'
}

export function continuationDomainForPendingActionType(type: string | null | undefined): ContinuationDomain {
  const normalized = (type ?? '').trim().toLowerCase()
  if (normalized === 'seo_audit') return 'seo'
  if (/(image|video|media|creative|social|campaign)/.test(normalized)) return 'creative'
  if (/(call|voice|phone)/.test(normalized)) return 'calls'
  if (/(browser|chrome|youtube|mac_command|computer)/.test(normalized)) return 'browser'
  return 'generic'
}

export function continuationDomainForPlanStep(input: {
  workflowKind?: string | null
  toolName?: string | null
}): ContinuationDomain {
  const workflowDomain = continuationDomainForWorkflowKind(input.workflowKind)
  if (workflowDomain !== 'generic') return workflowDomain
  const toolName = (input.toolName ?? '').trim().toLowerCase()
  if (toolName.startsWith('__grind_') || /seo/.test(toolName)) return 'seo'
  return continuationDomainForWorkflowKind(toolName)
}

function clean(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new ContinuationBindingError('continuation_binding_invalid', field)
  return normalized
}

function safeKeyPart(value: string): string {
  return /^[A-Za-z0-9._-]{1,160}$/.test(value)
    ? value
    : `sha256-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function normalizedStatuses(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ContinuationBindingError('continuation_binding_invalid', 'expected.sourceStatus')
  const statuses = [...new Set(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))].sort()
  if (!statuses.length) throw new ContinuationBindingError('continuation_binding_invalid', 'expected.sourceStatus')
  return statuses
}

export function normalizeContinuationBinding(value: unknown): ContinuationBindingV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'object')
  }
  const raw = value as Record<string, unknown>
  if (raw.v !== 1) throw new ContinuationBindingError('continuation_binding_invalid', 'v')
  if (!ORIGINS.has(raw.origin as ContinuationOrigin)) throw new ContinuationBindingError('continuation_binding_invalid', 'origin')
  if (!DOMAINS.has(raw.domain as ContinuationDomain)) throw new ContinuationBindingError('continuation_binding_invalid', 'domain')
  if (!EVENTS.has(raw.event as ContinuationEvent)) throw new ContinuationBindingError('continuation_binding_invalid', 'event')
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'source')
  }
  const source = raw.source as Record<string, unknown>
  if (!SOURCE_KINDS.has(source.kind as ContinuationSourceKind)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'source.kind')
  }
  if (!raw.directive || typeof raw.directive !== 'object' || Array.isArray(raw.directive)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'directive')
  }
  const directive = raw.directive as Record<string, unknown>
  if (directive.version !== 1 || !DIRECTIVES.has(directive.kind as ContinuationDirectiveKind)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'directive')
  }
  if (!raw.expected || typeof raw.expected !== 'object' || Array.isArray(raw.expected)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'expected')
  }
  const expected = raw.expected as Record<string, unknown>
  const workflowStateVersion = expected.workflowStateVersion
  if (workflowStateVersion !== undefined && (!Number.isInteger(workflowStateVersion) || Number(workflowStateVersion) < 1)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'expected.workflowStateVersion')
  }
  if (
    expected.deliveryState !== undefined
    && expected.deliveryState !== 'delivered'
    && expected.deliveryState !== 'message_delivered'
  ) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'expected.deliveryState')
  }
  const modalities = raw.modalities === undefined
    ? undefined
    : Array.isArray(raw.modalities) && raw.modalities.every((item) => item === 'chrome')
      ? [...new Set(raw.modalities as Array<'chrome'>)].sort()
      : (() => { throw new ContinuationBindingError('continuation_binding_invalid', 'modalities') })()
  const planId = raw.planId === undefined ? undefined : clean(raw.planId, 'planId')
  const subidentity = raw.subidentity === undefined ? undefined : clean(raw.subidentity, 'subidentity')
  const sourceDigest = raw.sourceDigest === undefined ? undefined : clean(raw.sourceDigest, 'sourceDigest').toLowerCase()
  if (sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'sourceDigest')
  }
  const steeringMessageIds = raw.steeringMessageIds === undefined
    ? undefined
    : Array.isArray(raw.steeringMessageIds)
      ? [...new Set(raw.steeringMessageIds.map((id) => clean(id, 'steeringMessageIds')))].sort()
      : (() => { throw new ContinuationBindingError('continuation_binding_invalid', 'steeringMessageIds') })()
  const authorityRef: ContinuationBindingV1['authorityRef'] = raw.authorityRef === undefined
    ? undefined
    : raw.authorityRef && typeof raw.authorityRef === 'object' && !Array.isArray(raw.authorityRef)
      ? (() => {
          const value = raw.authorityRef as Record<string, unknown>
          const kind = value.kind
          if (
            kind !== 'source_binding'
            && kind !== 'workflow_event'
            && kind !== 'conversation_focus'
            && kind !== 'checkpoint'
          ) {
            throw new ContinuationBindingError('continuation_binding_invalid', 'authorityRef.kind')
          }
          return { kind, id: clean(value.id, 'authorityRef.id') }
        })()
      : (() => { throw new ContinuationBindingError('continuation_binding_invalid', 'authorityRef') })()
  const ownerSteering = raw.origin === 'steering'
    && source.kind === 'turn'
    && raw.event === 'steering_applied'
    && directive.kind === 'owner_steering'
  const planStep = raw.origin === 'plan_driver'
    && source.kind === 'plan_step'
    && raw.event === 'step_dispatch'
    && directive.kind === 'plan_step_execute'
  const specialistBrief = raw.origin === 'specialist'
    && source.kind === 'pending_action'
    && raw.event === 'specialist_dispatch'
    && directive.kind === 'specialist_brief_execute'
  const selfContinue = raw.origin === 'self_continue'
    && source.kind === 'turn'
    && raw.event === 'deadline_resume'
    && directive.kind === 'deadline_resume'
  const hasSelfContinueShape = raw.origin === 'self_continue'
    || raw.event === 'deadline_resume'
    || directive.kind === 'deadline_resume'
    || authorityRef !== undefined
  const hasSteeringShape = raw.origin === 'steering'
    || raw.event === 'steering_applied'
    || directive.kind === 'owner_steering'
    || steeringMessageIds !== undefined
  if (hasSteeringShape && !ownerSteering && !planStep) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'ownerSteering')
  }
  if (ownerSteering && !steeringMessageIds?.length) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'steeringMessageIds')
  }
  if (!ownerSteering && !planStep && steeringMessageIds !== undefined) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'steeringMessageIds')
  }
  const hasPlanShape = raw.origin === 'plan_driver'
    || source.kind === 'plan_step'
    || raw.event === 'step_dispatch'
    || directive.kind === 'plan_step_execute'
    || planId !== undefined
  if (hasPlanShape && !planStep) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'planStep')
  }
  if (planStep && (!planId || !subidentity || !/^attempt-[1-9][0-9]*$/.test(subidentity))) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'planStepIdentity')
  }
  const hasSpecialistShape = raw.origin === 'specialist'
    || raw.event === 'specialist_dispatch'
    || directive.kind === 'specialist_brief_execute'
  if (hasSpecialistShape && !specialistBrief) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'specialistBrief')
  }
  if (specialistBrief && (!subidentity || !/^brief-[0-9]+$/.test(subidentity) || !sourceDigest)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'specialistBriefIdentity')
  }
  if (!specialistBrief && sourceDigest !== undefined) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'sourceDigest')
  }
  if (!planStep && !specialistBrief && (planId !== undefined || subidentity !== undefined)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'subidentity')
  }
  if (hasSelfContinueShape && !selfContinue) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'selfContinue')
  }
  if (selfContinue && !authorityRef) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'selfContinueAuthority')
  }

  return {
    v: 1,
    origin: raw.origin as ContinuationOrigin,
    source: { kind: source.kind as ContinuationSourceKind, id: clean(source.id, 'source.id') },
    conversationId: clean(raw.conversationId, 'conversationId'),
    domain: raw.domain as ContinuationDomain,
    event: raw.event as ContinuationEvent,
    ...(raw.workflowRunId === undefined ? {} : { workflowRunId: clean(raw.workflowRunId, 'workflowRunId') }),
    ...(planId ? { planId } : {}),
    ...(subidentity ? { subidentity } : {}),
    ...(sourceDigest ? { sourceDigest } : {}),
    ...(authorityRef ? { authorityRef } : {}),
    directive: { kind: directive.kind as ContinuationDirectiveKind, version: 1 },
    expected: {
      sourceStatus: normalizedStatuses(expected.sourceStatus),
      ...(expected.sourceType === undefined ? {} : { sourceType: clean(expected.sourceType, 'expected.sourceType') }),
      ...(expected.workflowKind === undefined ? {} : { workflowKind: clean(expected.workflowKind, 'expected.workflowKind') }),
      ...(workflowStateVersion === undefined ? {} : { workflowStateVersion: Number(workflowStateVersion) }),
      ...(expected.deliveryState === undefined
        ? {}
        : { deliveryState: expected.deliveryState as 'delivered' | 'message_delivered' }),
    },
    ...(modalities ? { modalities } : {}),
    ...(steeringMessageIds ? { steeringMessageIds } : {}),
  }
}

export function continuationRequestId(bindingInput: ContinuationBindingV1): string {
  const binding = normalizeContinuationBinding(bindingInput)
  return [
    'continuation', 'v1', binding.origin, binding.source.kind,
    safeKeyPart(binding.source.id), binding.event,
    ...(binding.subidentity ? [safeKeyPart(binding.subidentity)] : []),
  ].join(':')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function bindingAuthority(binding: ContinuationBindingV1) {
  const { sourceStatus: _sourceStatus, workflowStateVersion: _workflowStateVersion, ...stableExpected } = binding.expected
  return { ...binding, expected: stableExpected }
}

function sameBindingAuthority(left: unknown, right: ContinuationBindingV1): boolean {
  try {
    return stableJson(bindingAuthority(normalizeContinuationBinding(left))) === stableJson(bindingAuthority(right))
  } catch {
    return false
  }
}

function assertStatus(binding: ContinuationBindingV1, actual: unknown): void {
  if (!binding.expected.sourceStatus.includes(String(actual ?? ''))) {
    throw new ContinuationBindingError('continuation_source_status_mismatch')
  }
}

async function validateWorkflow(
  tx: any,
  binding: ContinuationBindingV1,
  workflowRunId: string | null,
): Promise<Record<string, unknown> | null> {
  const expectedId = binding.workflowRunId ?? null
  if (expectedId && expectedId !== workflowRunId) {
    throw new ContinuationBindingError('continuation_workflow_mismatch')
  }
  const id = expectedId ?? workflowRunId
  if (!id) {
    if (binding.expected.workflowKind || binding.expected.workflowStateVersion) {
      throw new ContinuationBindingError('continuation_workflow_missing')
    }
    return null
  }
  const workflow = await tx.workflowRun.findUnique({
    where: { id },
    select: {
      id: true, conversationId: true, kind: true, status: true, state: true,
      stateVersion: true, pendingActionId: true,
    },
  })
  if (!workflow) throw new ContinuationBindingError('continuation_workflow_missing')
  if (workflow.conversationId && workflow.conversationId !== binding.conversationId) {
    throw new ContinuationBindingError('continuation_source_conversation_mismatch')
  }
  if (binding.expected.workflowKind && workflow.kind !== binding.expected.workflowKind) {
    throw new ContinuationBindingError('continuation_workflow_kind_mismatch')
  }
  if (
    binding.expected.workflowStateVersion !== undefined
    && workflow.stateVersion !== binding.expected.workflowStateVersion
  ) {
    throw new ContinuationBindingError('continuation_workflow_version_mismatch')
  }
  const workflowDomain = continuationDomainForWorkflowKind(workflow.kind)
  if (workflowDomain !== 'generic' && workflowDomain !== binding.domain) {
    throw new ContinuationBindingError('continuation_source_domain_mismatch')
  }
  return workflow as Record<string, unknown>
}

function messageContent(row: { content: unknown }): string {
  const blocks = Array.isArray(row.content)
    ? row.content as Array<Record<string, unknown>>
    : []
  const text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text).trim())
    .filter(Boolean)
    .join('\n')
  const files = blocks
    .filter((block) => block.type === 'file_ref' && typeof block.path === 'string')
    .map((block) => `- attachment: ${String(block.path)} (${String(block.mediaType ?? 'file')})`)
  return [text, ...files].filter(Boolean).join('\n')
}

async function persistedSteeringPrompt(
  tx: any,
  binding: ContinuationBindingV1,
  mode: 'turn' | 'plan_step',
): Promise<string> {
  const steeringIds = binding.steeringMessageIds ?? []
  if (steeringIds.length === 0) return ''
  const messages: Array<{ id: string; role: string; content: unknown; usage: unknown }> =
    await tx.agentMessage.findMany({
      where: {
        id: { in: steeringIds },
        conversationId: binding.conversationId,
        role: 'user',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, role: true, content: true, usage: true, createdAt: true },
    })
  const actualIds = new Set(messages.map((message) => message.id))
  if (messages.length !== steeringIds.length || steeringIds.some((id) => !actualIds.has(id))) {
    throw new ContinuationBindingError('continuation_steering_source_mismatch')
  }
  const prompts: string[] = []
  for (const message of messages) {
    const usage = message.usage && typeof message.usage === 'object'
      ? message.usage as Record<string, unknown>
      : {}
    if (mode === 'turn') {
      const steering = usage.steering && typeof usage.steering === 'object'
        ? usage.steering as Record<string, unknown>
        : {}
      if (
        steering.targetTurnId !== binding.source.id
        || (steering.status !== 'queued' && steering.status !== 'consumed')
      ) {
        throw new ContinuationBindingError('continuation_steering_source_mismatch')
      }
    } else if (usage.steeringConsumedBy !== binding.source.id) {
      throw new ContinuationBindingError('continuation_steering_source_mismatch')
    }
    const ownerContent = messageContent(message)
    if (!ownerContent) throw new ContinuationBindingError('continuation_steering_source_empty')
    prompts.push(ownerContent)
  }
  const steeringWrapper =
    '[BOSS LIVE UPDATE — persisted owner messages bound to this execution source. ' +
    'Treat these as the newest owner instruction; checkpoint completed effects and never start a duplicate turn.]'
  return `${steeringWrapper}\n${prompts.join('\n\n')}`
}

function planStepKind(toolName: string | null): 'diagnose' | 'fix' | 'verify' | 'regression' | 'generic' {
  const value = toolName ?? ''
  if (value.startsWith('__grind_diagnose')) return 'diagnose'
  if (value.startsWith('__grind_fix')) return 'fix'
  if (value.startsWith('__grind_verify')) return 'verify'
  if (value.startsWith('__grind_regression')) return 'regression'
  return 'generic'
}

const PLAN_STEP_RULES = {
  generic: '- শুধু এই ধাপটাই করো; পরিকল্পনার অন্য ধাপ এখন ছুঁয়ো না।',
  diagnose: '- এটা DIAGNOSIS ধাপ: কিছু পরিবর্তন কোরো না; মূল কারণ ও প্রমাণ বের করে record_root_cause-এ লেখো।',
  fix: '- এটা FIX ধাপ: persisted diagnosis ধরে শুধু এই ব্যাচ ঠিক করো; কারণ না মিললে needs_rediagnosis চিহ্নিত করো।',
  verify: '- এটা VERIFY ধাপ: নতুন fix নয়; টুল দিয়ে আবার মেপে persisted ফল লেখো।',
  regression: '- এটা REGRESSION ধাপ: আগের fix নতুন সমস্যা করেছে কিনা মেপে সত্য ফল জানাও।',
} as const

async function renderPersistedPlanStep(
  tx: any,
  binding: ContinuationBindingV1,
  plan: Record<string, unknown>,
  step: Record<string, unknown>,
): Promise<string> {
  const toolName = typeof step.toolName === 'string' ? step.toolName : null
  const kind = planStepKind(toolName)
  const attemptCount = Number(step.attemptCount ?? 0)
  const retry = attemptCount > 0
    ? `\n[চেষ্টা ${attemptCount + 1}; আগের ভুল: ${String(step.error ?? 'অজানা').slice(0, 200)}]`
    : ''
  let proposalMode = ''
  if (kind === 'fix') {
    const metaRow = await tx.agentKvSetting.findUnique({
      where: { key: `grind_step:${binding.source.id}` },
      select: { value: true },
    })
    try {
      const meta = metaRow?.value ? JSON.parse(String(metaRow.value)) as Record<string, unknown> : null
      if (meta && typeof meta.setId === 'string' && typeof meta.family === 'string') {
        const set = await tx.agentFindingSet.findUnique({
          where: { id: meta.setId },
          select: { target: true },
        })
        if (set?.target) {
          const grant = await tx.agentKvSetting.findUnique({
            where: { key: `grind_family_grant:${set.target}|${meta.family}` },
            select: { value: true },
          })
          if (grant?.value !== 'granted') {
            proposalMode = '\n\n[PROPOSAL MODE] কিছু পরিবর্তন কোরো না। exact before/after প্রস্তাব দেখিয়ে ask_user card-এ Boss-এর অনুমতি চাও।'
          }
        }
      }
    } catch {
      throw new ContinuationBindingError('continuation_plan_metadata_invalid')
    }
  }
  const steering = await persistedSteeringPrompt(tx, binding, 'plan_step')
  const toolHint = toolName && !toolName.startsWith('__') ? `\nসম্ভাব্য টুল: ${toolName}` : ''
  return [
    steering,
    '[স্বয়ংক্রিয় Plan-Driver — persisted source-bound step]',
    `সামগ্রিক লক্ষ্য: ${String(plan.goal)}`,
    `এখন শুধু এই ধাপ: ${String(step.action)}${toolHint}${retry}`,
    `নিয়ম:\n${PLAN_STEP_RULES[kind]}\n- দরকারি টুল সত্যিই চালাও ও ফল যাচাই করো।\n- irreversible কাজের আগে approval card দাও।\n- শেষে ১–২ লাইনে Boss-কে সত্য ফল জানাও।${proposalMode}`,
  ].filter(Boolean).join('\n\n')
}

function checkpointTaskType(row: Record<string, unknown>): string | null {
  const checkpoint = row.checkpoint && typeof row.checkpoint === 'object' && !Array.isArray(row.checkpoint)
    ? row.checkpoint as Record<string, unknown>
    : null
  return checkpoint && typeof checkpoint.taskType === 'string' ? checkpoint.taskType : null
}

async function validateSelfContinueAuthority(
  tx: any,
  binding: ContinuationBindingV1,
  sourceTurn: Record<string, unknown>,
): Promise<void> {
  const ref = binding.authorityRef
  if (!ref) {
    if (
      binding.domain !== 'generic'
      || binding.workflowRunId
      || binding.expected.workflowKind
      || binding.expected.workflowStateVersion !== undefined
    ) {
      throw new ContinuationBindingError('continuation_self_authority_missing')
    }
    return
  }

  let workflowRunId: string | null = null
  let evidenceDomain: ContinuationDomain = 'generic'
  if (ref.kind === 'source_binding') {
    if (sourceTurn.requestId !== ref.id) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    const predecessor = normalizeContinuationBinding(sourceTurn.continuationBinding)
    if (continuationRequestId(predecessor) !== ref.id) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    workflowRunId = predecessor.workflowRunId ?? null
    evidenceDomain = predecessor.domain
  } else if (ref.kind === 'workflow_event') {
    const event = await tx.workflowRunEvent.findUnique({
      where: { id: ref.id },
      select: { id: true, workflowRunId: true, detail: true },
    })
    const detail = event?.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
      ? event.detail as Record<string, unknown>
      : {}
    if (!event || detail.turnId !== binding.source.id) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    workflowRunId = String(event.workflowRunId)
  } else if (ref.kind === 'conversation_focus') {
    const focus = await tx.agentConversationFocus.findUnique({
      where: { id: ref.id },
      select: {
        id: true, conversationId: true, status: true, kind: true,
        workflowRunId: true, artifacts: true,
      },
    })
    const artifacts = focus?.artifacts && typeof focus.artifacts === 'object' && !Array.isArray(focus.artifacts)
      ? focus.artifacts as Record<string, unknown>
      : {}
    if (
      !focus
      || focus.conversationId !== binding.conversationId
      || !['active', 'awaiting_owner'].includes(String(focus.status))
      || artifacts.intakeTurnId !== binding.source.id
    ) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    workflowRunId = typeof focus.workflowRunId === 'string' ? focus.workflowRunId : null
    evidenceDomain = continuationDomainForWorkflowKind(String(focus.kind ?? ''))
  } else {
    const checkpoint = await tx.agentOpenTask.findUnique({
      where: { id: ref.id },
      select: {
        id: true, conversationId: true, status: true, workflowRunId: true,
        checkpoint: true,
      },
    })
    const payload = checkpoint?.checkpoint && typeof checkpoint.checkpoint === 'object' && !Array.isArray(checkpoint.checkpoint)
      ? checkpoint.checkpoint as Record<string, unknown>
      : {}
    if (
      !checkpoint
      || checkpoint.conversationId !== binding.conversationId
      || !['open', 'running'].includes(String(checkpoint.status))
      || payload.taskRef !== binding.source.id
    ) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    workflowRunId = typeof checkpoint.workflowRunId === 'string' ? checkpoint.workflowRunId : null
    evidenceDomain = continuationDomainForWorkflowKind(checkpointTaskType(checkpoint))
  }

  if ((binding.workflowRunId ?? null) !== workflowRunId) {
    throw new ContinuationBindingError('continuation_workflow_mismatch')
  }
  if (workflowRunId) {
    const workflow = await validateWorkflow(tx, binding, workflowRunId)
    evidenceDomain = continuationDomainForWorkflowKind(String(workflow?.kind ?? ''))
  }
  if (binding.domain !== evidenceDomain) {
    throw new ContinuationBindingError('continuation_source_domain_mismatch')
  }
}

async function validateSource(
  tx: any,
  binding: ContinuationBindingV1,
  executionTurnId?: string,
): Promise<DirectiveContext> {
  if (binding.source.kind === 'pending_action') {
    const action = await tx.agentPendingAction.findUnique({
      where: { id: binding.source.id },
      select: {
        id: true, conversationId: true, type: true, status: true,
        workflowRunId: true, payload: true, result: true,
      },
    })
    if (!action) throw new ContinuationBindingError('continuation_source_not_found')
    if (action.conversationId !== binding.conversationId) {
      throw new ContinuationBindingError('continuation_source_conversation_mismatch')
    }
    assertStatus(binding, action.status)
    if (binding.expected.sourceType && action.type !== binding.expected.sourceType) {
      throw new ContinuationBindingError('continuation_source_type_mismatch')
    }
    const workflow = await validateWorkflow(tx, binding, action.workflowRunId ?? null)
    const actionDomain = continuationDomainForPendingActionType(action.type)
    const workflowDomain = continuationDomainForWorkflowKind(
      typeof workflow?.kind === 'string' ? workflow.kind : null,
    )
    const sourceDomain = workflowDomain !== 'generic' ? workflowDomain : actionDomain
    if (sourceDomain !== binding.domain) {
      throw new ContinuationBindingError('continuation_source_domain_mismatch')
    }
    if (workflow?.pendingActionId && workflow.pendingActionId !== action.id) {
      throw new ContinuationBindingError('continuation_workflow_source_mismatch')
    }
    if (binding.expected.deliveryState === 'delivered') {
      const outbox = await tx.agentArtifactDeliveryOutbox.findFirst({
        where: {
          sourceKind: 'pending_action',
          sourceId: binding.source.id,
          status: 'delivered',
        },
        select: { id: true, status: true },
      })
      const delivery = action.result && typeof action.result === 'object'
        ? (action.result as Record<string, unknown>).__delivery
        : null
      const legacyDelivered = Boolean(
        delivery
        && typeof delivery === 'object'
        && (delivery as Record<string, unknown>).state === 'delivered',
      )
      if (!outbox && !legacyDelivered) {
        throw new ContinuationBindingError('continuation_delivery_not_ready')
      }
    }
    if (binding.expected.deliveryState === 'message_delivered') {
      const message = await tx.agentMessage.findUnique({
        where: { clientRequestId: `job-result:image:${binding.source.id}` },
        select: { id: true, conversationId: true },
      })
      if (!message || message.conversationId !== binding.conversationId) {
        throw new ContinuationBindingError('continuation_delivery_not_ready')
      }
    }
    if (binding.event === 'specialist_dispatch') {
      if (action.type !== 'agent_graph_run') {
        throw new ContinuationBindingError('continuation_source_type_mismatch')
      }
      const index = Number(binding.subidentity?.slice('brief-'.length))
      const payload = action.payload && typeof action.payload === 'object'
        ? action.payload as Record<string, unknown>
        : {}
      const briefs = Array.isArray(payload.briefs) ? payload.briefs : []
      const brief = Number.isInteger(index) ? briefs[index] : null
      if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
        throw new ContinuationBindingError('continuation_specialist_brief_missing')
      }
      const digest = createHash('sha256').update(stableJson(brief)).digest('hex')
      if (binding.sourceDigest !== digest) {
        throw new ContinuationBindingError('continuation_specialist_brief_mismatch')
      }
      const progress = action.result && typeof action.result === 'object'
        ? (action.result as Record<string, unknown>).graphRunProgress
        : null
      const completed = progress && typeof progress === 'object'
        && Array.isArray((progress as Record<string, unknown>).completed)
        ? (progress as { completed: unknown[] }).completed
        : []
      if (completed.some((item) => Number(item) === index)) {
        throw new ContinuationBindingError('continuation_specialist_brief_completed')
      }
      const row = brief as Record<string, unknown>
      const role = clean(row.role, 'specialist.role')
      const task = clean(row.task, 'specialist.task')
      return {
        specialistBriefDirective:
          `[INTERNAL SPECIALIST BRIEF — persisted action ${binding.source.id}, index ${index}, role: ${role}]\n` +
          `${task}\nশুধু তথ্যভিত্তিক findings/evidence/অনিশ্চয়তা/পরের ধাপের প্রস্তাব দাও; মালিককে সরাসরি সম্বোধন কোরো না।`,
      }
    }
    return {}
  }

  if (binding.source.kind === 'open_task') {
    const task = await tx.agentOpenTask.findUnique({
      where: { id: binding.source.id },
      select: {
        id: true, conversationId: true, status: true, kind: true, workflowRunId: true,
        pendingActionId: true, resumeNote: true,
      },
    })
    if (!task) throw new ContinuationBindingError('continuation_source_not_found')
    if (task.conversationId !== binding.conversationId) {
      throw new ContinuationBindingError('continuation_source_conversation_mismatch')
    }
    assertStatus(binding, task.status)
    if (binding.expected.sourceType && task.kind !== binding.expected.sourceType) {
      throw new ContinuationBindingError('continuation_source_type_mismatch')
    }
    const workflow = await validateWorkflow(tx, binding, task.workflowRunId ?? null)
    const taskDomain = workflow
      ? continuationDomainForWorkflowKind(String(workflow.kind ?? ''))
      : 'generic'
    if (taskDomain !== binding.domain) {
      throw new ContinuationBindingError('continuation_source_domain_mismatch')
    }
    return { openTaskResumeNote: clean(task.resumeNote, 'openTask.resumeNote') }
  }

  if (binding.source.kind === 'workflow_run') {
    if (binding.workflowRunId && binding.workflowRunId !== binding.source.id) {
      throw new ContinuationBindingError('continuation_workflow_mismatch')
    }
    const workflow = await validateWorkflow(tx, { ...binding, workflowRunId: binding.source.id }, binding.source.id)
    if (!workflow) throw new ContinuationBindingError('continuation_source_not_found')
    assertStatus(binding, workflow.status)
    return {}
  }

  if (binding.source.kind === 'plan_step') {
    const step = await tx.agentPlanStep.findUnique({
      where: { id: binding.source.id },
      select: {
        id: true, planId: true, action: true, toolName: true, status: true,
        error: true, attemptCount: true, turnId: true,
      },
    })
    if (!step) throw new ContinuationBindingError('continuation_source_not_found')
    if (step.planId !== binding.planId) {
      throw new ContinuationBindingError('continuation_plan_mismatch')
    }
    if (executionTurnId && step.turnId !== executionTurnId) {
      throw new ContinuationBindingError('continuation_plan_turn_mismatch')
    }
    assertStatus(binding, step.status)
    if (
      binding.expected.sourceType
      && (step.toolName ?? 'generic') !== binding.expected.sourceType
    ) {
      throw new ContinuationBindingError('continuation_source_type_mismatch')
    }
    const plan = await tx.agentPlan.findUnique({
      where: { id: step.planId },
      select: {
        id: true, conversationId: true, businessId: true, goal: true, status: true,
        workflowRunId: true, autodriveState: true, originTurnId: true,
      },
    })
    if (!plan) throw new ContinuationBindingError('continuation_plan_missing')
    if (plan.conversationId !== binding.conversationId) {
      throw new ContinuationBindingError('continuation_source_conversation_mismatch')
    }
    if (!['approved', 'executing'].includes(String(plan.status)) || plan.autodriveState !== 'driving') {
      throw new ContinuationBindingError('continuation_plan_not_driving')
    }
    if ((binding.workflowRunId ?? null) !== (plan.workflowRunId ?? null)) {
      throw new ContinuationBindingError('continuation_workflow_mismatch')
    }
    let workflowKind: string | null = null
    if (plan.workflowRunId) {
      const workflow = await validateWorkflow(tx, binding, plan.workflowRunId)
      workflowKind = typeof workflow?.kind === 'string' ? workflow.kind : null
    }
    const domain = continuationDomainForPlanStep({ workflowKind, toolName: step.toolName })
    if (domain !== binding.domain) {
      throw new ContinuationBindingError('continuation_source_domain_mismatch')
    }
    return { planStepDirective: await renderPersistedPlanStep(tx, binding, plan, step) }
  }

  const turn = await tx.agentTurn.findUnique({
    where: { id: binding.source.id },
    select: {
      id: true, conversationId: true, status: true,
      requestId: true, continuationBinding: true,
    },
  })
  if (!turn) throw new ContinuationBindingError('continuation_source_not_found')
  if (turn.conversationId !== binding.conversationId) {
    throw new ContinuationBindingError('continuation_source_conversation_mismatch')
  }
  assertStatus(binding, turn.status)
  if (binding.event === 'steering_applied') {
    if (binding.domain !== 'generic' || binding.workflowRunId || binding.authorityRef) {
      throw new ContinuationBindingError('continuation_source_domain_mismatch')
    }
    return { ownerSteeringPrompt: await persistedSteeringPrompt(tx, binding, 'turn') }
  }
  if (binding.event === 'deadline_resume') {
    await validateSelfContinueAuthority(tx, binding, turn)
    return {}
  }
  if (binding.domain !== 'generic') {
    throw new ContinuationBindingError('continuation_source_domain_mismatch')
  }
  return {}
}

function rowResult(row: Record<string, unknown>, created: boolean): BoundContinuationTurn {
  return {
    turnId: String(row.id),
    requestId: String(row.requestId),
    status: String(row.status),
    created,
  }
}

async function attachPlanStepTurn(
  tx: any,
  binding: ContinuationBindingV1,
  turnId: string,
): Promise<void> {
  if (binding.source.kind !== 'plan_step') return
  const attached = await tx.agentPlanStep.updateMany({
    where: {
      id: binding.source.id,
      planId: binding.planId,
      status: { in: binding.expected.sourceStatus },
      OR: [{ turnId: null }, { turnId }],
    },
    data: { turnId },
  })
  if (attached.count === 1) return
  const current = await tx.agentPlanStep.findUnique({
    where: { id: binding.source.id },
    select: { turnId: true },
  })
  if (current?.turnId !== turnId) {
    throw new ContinuationBindingError('continuation_plan_turn_conflict')
  }
}

async function existingBoundTurn(tx: any, requestId: string, binding: ContinuationBindingV1) {
  const existing = await tx.agentTurn.findUnique({
    where: { requestId },
    select: {
      id: true, conversationId: true, requestId: true,
      continuationBinding: true, status: true,
    },
  })
  if (!existing) return null
  if (existing.conversationId !== binding.conversationId || !sameBindingAuthority(existing.continuationBinding, binding)) {
    throw new ContinuationBindingError('continuation_binding_conflict')
  }
  return existing
}

export async function bindContinuationTurn(input: {
  binding: ContinuationBindingV1
  preferredTurnId?: string | null
  executionMode?: 'inline' | 'worker'
}): Promise<BoundContinuationTurn> {
  const binding = normalizeContinuationBinding(input.binding)
  const requestId = continuationRequestId(binding)
  try {
    return await db().$transaction(async (tx: any) => {
      // Replay identity wins before mutable source state is inspected. The first
      // executor may legitimately advance open→running (or a workflow version),
      // and a duplicate must observe that exact immutable turn rather than fail
      // source preconditions that were true when the binding was created.
      const existing = await existingBoundTurn(tx, requestId, binding)
      if (existing) return rowResult(existing, false)
      await validateSource(tx, binding)

      const preferredTurnId = input.preferredTurnId?.trim() ?? ''
      if (preferredTurnId) {
        const preferred = await tx.agentTurn.findFirst({
          where: { id: preferredTurnId, conversationId: binding.conversationId },
          select: {
            id: true, conversationId: true, requestId: true,
            continuationBinding: true, continuationExecutionClaimedAt: true,
            status: true,
          },
        })
        if (
          preferred
          && preferred.status === 'running'
          && preferred.requestId == null
          && preferred.continuationBinding == null
          && preferred.continuationExecutionClaimedAt == null
        ) {
          const attached = await tx.agentTurn.updateMany({
            where: {
              id: preferred.id,
              conversationId: binding.conversationId,
              status: 'running',
              requestId: null,
              continuationExecutionClaimedAt: null,
            },
            data: {
              requestId,
              continuationBinding: binding,
              executionMode: input.executionMode ?? preferred.executionMode ?? null,
              instructionOrigin: 'owner_policy',
            },
          })
          if (attached.count === 1) {
            await attachPlanStepTurn(tx, binding, preferred.id)
            return rowResult({ ...preferred, requestId, continuationBinding: binding }, true)
          }
          const raced = await existingBoundTurn(tx, requestId, binding)
          if (raced) return rowResult(raced, false)
        }
      }

      const created = await tx.agentTurn.create({
        data: {
          conversationId: binding.conversationId,
          requestId,
          continuationBinding: binding,
          status: 'running',
          executionMode: input.executionMode ?? null,
          instructionOrigin: 'owner_policy',
          versions: AGENT_VERSIONS,
        },
        select: { id: true, conversationId: true, requestId: true, status: true },
      })
      await attachPlanStepTurn(tx, binding, String(created.id))
      return rowResult(created, true)
    })
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      const raced = await db().agentTurn.findUnique({
        where: { requestId },
        select: {
          id: true, conversationId: true, requestId: true,
          continuationBinding: true, status: true,
        },
      })
      if (raced && raced.conversationId === binding.conversationId && sameBindingAuthority(raced.continuationBinding, binding)) {
        return rowResult(raced, false)
      }
    }
    throw error
  }
}

/** Route-oriented name: create when absent, otherwise return the exact prior turn. */
export const createOrReuseBoundContinuationTurn = bindContinuationTurn

/**
 * Replay preflight for routes whose mutable source may already be terminal.
 * Returns only an existing, structurally matching immutable binding; it never
 * creates a turn and therefore cannot admit an unclaimed terminal source.
 */
export async function findExistingBoundContinuationTurn(input: {
  conversationId: string
  origin: ContinuationOrigin
  source: { kind: ContinuationSourceKind; id: string }
  event: ContinuationEvent
  subidentity?: string
}): Promise<(BoundContinuationTurn & {
  binding: ContinuationBindingV1
  /** True only after the one-way generative execution CAS won. */
  executionClaimed: boolean
}) | null> {
  const conversationId = clean(input.conversationId, 'conversationId')
  if (!ORIGINS.has(input.origin) || !SOURCE_KINDS.has(input.source.kind) || !EVENTS.has(input.event)) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'identity')
  }
  const sourceId = clean(input.source.id, 'source.id')
  const subidentity = input.subidentity === undefined ? undefined : clean(input.subidentity, 'subidentity')
  const requestId = [
    'continuation', 'v1', input.origin, input.source.kind,
    safeKeyPart(sourceId), input.event,
    ...(subidentity ? [safeKeyPart(subidentity)] : []),
  ].join(':')
  const row = await db().agentTurn.findUnique({
    where: { requestId },
    select: {
      id: true, conversationId: true, requestId: true,
      continuationBinding: true, continuationExecutionClaimedAt: true, status: true,
    },
  })
  if (!row) return null
  const binding = normalizeContinuationBinding(row.continuationBinding)
  if (
    row.conversationId !== conversationId
    || binding.conversationId !== conversationId
    || binding.origin !== input.origin
    || binding.source.kind !== input.source.kind
    || binding.source.id !== sourceId
    || binding.event !== input.event
    || (binding.subidentity ?? undefined) !== subidentity
    || continuationRequestId(binding) !== requestId
  ) {
    throw new ContinuationBindingError('continuation_binding_conflict')
  }
  return {
    ...rowResult(row, false),
    binding,
    executionClaimed: row.continuationExecutionClaimedAt != null,
  }
}

export type UnclaimedContinuationSettlement = {
  settled: boolean
  status: string
  executionClaimed: boolean
  sourceStatus: string
}

/**
 * Cancel a deferred open-task turn only after its exact source became terminal.
 * The source read and turn CAS share one transaction; a concurrent execution
 * claim wins and is observed, never canceled underneath the executor.
 */
export async function settleUnclaimedOpenTaskContinuation(input: {
  conversationId: string
  turnId: string
  requestId: string
}): Promise<UnclaimedContinuationSettlement> {
  const conversationId = clean(input.conversationId, 'conversationId')
  const turnId = clean(input.turnId, 'turnId')
  const requestId = clean(input.requestId, 'requestId')
  return db().$transaction(async (tx: any) => {
    const row = await tx.agentTurn.findUnique({
      where: { id: turnId },
      select: {
        id: true, conversationId: true, requestId: true, status: true,
        continuationBinding: true, continuationExecutionClaimedAt: true,
      },
    })
    if (!row) throw new ContinuationBindingError('continuation_turn_not_found')
    const binding = normalizeContinuationBinding(row.continuationBinding)
    if (
      row.conversationId !== conversationId
      || row.requestId !== requestId
      || binding.conversationId !== conversationId
      || continuationRequestId(binding) !== requestId
      || binding.source.kind !== 'open_task'
      || binding.event !== 'resume_requested'
    ) {
      throw new ContinuationBindingError('continuation_turn_identity_mismatch')
    }
    const task = await tx.agentOpenTask.findUnique({
      where: { id: binding.source.id },
      select: { conversationId: true, status: true },
    })
    if (!task || task.conversationId !== conversationId) {
      throw new ContinuationBindingError('continuation_source_conversation_mismatch')
    }
    const sourceStatus = String(task.status)
    if (row.status !== 'running' || row.continuationExecutionClaimedAt) {
      return {
        settled: false,
        status: String(row.status),
        executionClaimed: row.continuationExecutionClaimedAt != null,
        sourceStatus,
      }
    }
    if (!['done', 'cancelled', 'canceled'].includes(sourceStatus)) {
      throw new ContinuationBindingError('continuation_source_status_mismatch')
    }
    const settled = await tx.agentTurn.updateMany({
      where: {
        id: turnId,
        conversationId,
        requestId,
        status: 'running',
        continuationExecutionClaimedAt: null,
      },
      data: { status: 'canceled', finishedAt: new Date() },
    })
    if (settled.count === 1) {
      return { settled: true, status: 'canceled', executionClaimed: false, sourceStatus }
    }
    const raced = await tx.agentTurn.findUnique({
      where: { id: turnId },
      select: { status: true, continuationExecutionClaimedAt: true },
    })
    return {
      settled: false,
      status: String(raced?.status ?? 'missing'),
      executionClaimed: raced?.continuationExecutionClaimedAt != null,
      sourceStatus,
    }
  })
}

type SelfContinueEvidence = {
  authorityRef: NonNullable<ContinuationBindingV1['authorityRef']>
  domain: ContinuationDomain
  workflowRunId: string | null
}

async function selfContinueWorkflowEvidence(
  sourceTurnId: string,
): Promise<SelfContinueEvidence | null> {
  const events: Array<{ id: string; workflowRunId: string }> = await db().workflowRunEvent.findMany({
    where: { detail: { path: ['turnId'], equals: sourceTurnId } },
    orderBy: { ts: 'desc' },
    take: 12,
    select: { id: true, workflowRunId: true },
  })
  if (!events.length) return null
  const runIds = [...new Set(events.map((event) => String(event.workflowRunId)))]
  if (runIds.length !== 1) {
    throw new ContinuationBindingError('continuation_self_source_ambiguous', 'workflow_event')
  }
  const workflow = await db().workflowRun.findUnique({
    where: { id: runIds[0] },
    select: { id: true, conversationId: true, kind: true, status: true, stateVersion: true },
  })
  if (!workflow) throw new ContinuationBindingError('continuation_workflow_missing')
  if (!['active', 'waiting_owner', 'waiting_worker'].includes(String(workflow.status))) {
    throw new ContinuationBindingError('continuation_self_workflow_terminal')
  }
  return {
    authorityRef: { kind: 'workflow_event', id: String(events[0].id) },
    domain: continuationDomainForWorkflowKind(String(workflow.kind)),
    workflowRunId: String(workflow.id),
  }
}

async function selfContinueFocusEvidence(
  conversationId: string,
  sourceTurnId: string,
): Promise<SelfContinueEvidence | null> {
  const rows: Array<Record<string, unknown>> = await db().agentConversationFocus.findMany({
    where: { conversationId, status: { in: ['active', 'awaiting_owner'] } },
    orderBy: { updatedAt: 'desc' },
    take: 12,
    select: {
      id: true, conversationId: true, status: true, kind: true,
      workflowRunId: true, artifacts: true,
    },
  })
  const exact = rows.filter((row) => {
    const artifacts = row.artifacts && typeof row.artifacts === 'object' && !Array.isArray(row.artifacts)
      ? row.artifacts as Record<string, unknown>
      : {}
    return artifacts.intakeTurnId === sourceTurnId
  })
  if (!exact.length) return null
  const identities = new Set(exact.map((row) => (
    `${String(row.workflowRunId ?? '')}:${continuationDomainForWorkflowKind(String(row.kind ?? ''))}`
  )))
  if (identities.size !== 1) {
    throw new ContinuationBindingError('continuation_self_source_ambiguous', 'conversation_focus')
  }
  const row = exact[0]
  return {
    authorityRef: { kind: 'conversation_focus', id: String(row.id) },
    domain: continuationDomainForWorkflowKind(String(row.kind ?? '')),
    workflowRunId: typeof row.workflowRunId === 'string' ? row.workflowRunId : null,
  }
}

async function selfContinueCheckpointEvidence(
  conversationId: string,
  sourceTurnId: string,
): Promise<SelfContinueEvidence | null> {
  const rows: Array<Record<string, unknown>> = await db().agentOpenTask.findMany({
    where: {
      conversationId,
      kind: { in: ['checkpoint_failed', 'checkpoint_waiting', 'checkpoint_continuing'] },
      status: { in: ['open', 'running'] },
    },
    orderBy: { updatedAt: 'desc' },
    take: 12,
    select: {
      id: true, conversationId: true, status: true, workflowRunId: true,
      checkpoint: true,
    },
  })
  const exact = rows.filter((row) => {
    const checkpoint = row.checkpoint && typeof row.checkpoint === 'object' && !Array.isArray(row.checkpoint)
      ? row.checkpoint as Record<string, unknown>
      : {}
    return checkpoint.taskRef === sourceTurnId
  })
  if (!exact.length) return null
  const identities = new Set(exact.map((row) => (
    `${String(row.workflowRunId ?? '')}:${continuationDomainForWorkflowKind(checkpointTaskType(row))}`
  )))
  if (identities.size !== 1) {
    throw new ContinuationBindingError('continuation_self_source_ambiguous', 'checkpoint')
  }
  const row = exact[0]
  return {
    authorityRef: { kind: 'checkpoint', id: String(row.id) },
    domain: continuationDomainForWorkflowKind(checkpointTaskType(row)),
    workflowRunId: typeof row.workflowRunId === 'string' ? row.workflowRunId : null,
  }
}

/**
 * Does the source turn already carry STRONG self-continue authority evidence —
 * its own continuation binding, an exact workflow event, or an intake focus?
 * The deadline salvage uses this to decide whether it must write its generic
 * work-remaining checkpoint: writing one BESIDE stronger evidence creates a
 * second identity and buildSelfContinueBinding then rejects the wake as
 * continuation_self_source_ambiguous (Codex P1 #850 r6). Checkpoint evidence
 * is deliberately excluded — it is exactly what the caller would be writing.
 */
export async function hasStrongSelfContinueEvidence(input: {
  conversationId: string
  sourceTurnId: string
}): Promise<boolean> {
  try {
    const source = await db().agentTurn.findUnique({
      where: { id: clean(input.sourceTurnId, 'sourceTurnId') },
      select: { continuationBinding: true },
    })
    if (source?.continuationBinding != null) return true
    const candidates = [
      await selfContinueWorkflowEvidence(input.sourceTurnId),
      await selfContinueFocusEvidence(input.conversationId, input.sourceTurnId),
    ].filter((candidate): candidate is SelfContinueEvidence => candidate !== null)
    return candidates.length > 0
  } catch {
    // Unknown state: claim no strong evidence so the caller writes the
    // fallback checkpoint — a duplicate-identity rejection is recoverable by
    // the owner, a wake with zero evidence is not.
    return false
  }
}

/**
 * Builds a deadline wake solely from persisted source identity. Direct source
 * binding wins; otherwise an exact workflow event, intake focus, or checkpoint
 * may establish the domain. Missing or conflicting evidence rejects instead of
 * silently recreating the historical generic/transcript fallback.
 */
export async function buildSelfContinueBinding(input: {
  conversationId: string
  sourceTurnId: string
}): Promise<ContinuationBindingV1> {
  const conversationId = clean(input.conversationId, 'conversationId')
  const sourceTurnId = clean(input.sourceTurnId, 'sourceTurnId')
  const source = await db().agentTurn.findUnique({
    where: { id: sourceTurnId },
    select: {
      id: true, conversationId: true, status: true,
      requestId: true, continuationBinding: true,
    },
  })
  if (!source) throw new ContinuationBindingError('continuation_source_not_found')
  if (source.conversationId !== conversationId) {
    throw new ContinuationBindingError('continuation_source_conversation_mismatch')
  }
  if (!['running', 'done'].includes(String(source.status))) {
    throw new ContinuationBindingError('continuation_source_status_mismatch')
  }

  let evidence: SelfContinueEvidence | null = null
  if (source.continuationBinding != null) {
    const predecessor = normalizeContinuationBinding(source.continuationBinding)
    const requestId = continuationRequestId(predecessor)
    if (
      source.requestId !== requestId
      || predecessor.conversationId !== conversationId
    ) {
      throw new ContinuationBindingError('continuation_self_authority_mismatch')
    }
    evidence = {
      authorityRef: { kind: 'source_binding', id: requestId },
      domain: predecessor.domain,
      workflowRunId: predecessor.workflowRunId ?? null,
    }
  } else {
    const candidates = [
      await selfContinueWorkflowEvidence(sourceTurnId),
      await selfContinueFocusEvidence(conversationId, sourceTurnId),
      await selfContinueCheckpointEvidence(conversationId, sourceTurnId),
    ].filter((candidate): candidate is SelfContinueEvidence => candidate !== null)
    const identities = new Set(candidates.map((candidate) => (
      candidate.workflowRunId
        ? `workflow:${candidate.workflowRunId}`
        : `domain:${candidate.domain}`
    )))
    if (identities.size > 1) {
      throw new ContinuationBindingError('continuation_self_source_ambiguous', 'persisted_context')
    }
    // Strongest exact join first: workflow event → intake focus → checkpoint.
    evidence = candidates[0] ?? null
  }
  if (!evidence) {
    throw new ContinuationBindingError('continuation_self_authority_missing')
  }

  let workflow: { kind: string; stateVersion: number; conversationId: string | null; status: string } | null = null
  if (evidence?.workflowRunId) {
    workflow = await db().workflowRun.findUnique({
      where: { id: evidence.workflowRunId },
      select: { kind: true, stateVersion: true, conversationId: true, status: true },
    })
    if (!workflow) throw new ContinuationBindingError('continuation_workflow_missing')
    if (workflow.conversationId && workflow.conversationId !== conversationId) {
      throw new ContinuationBindingError('continuation_source_conversation_mismatch')
    }
    if (!['active', 'waiting_owner', 'waiting_worker'].includes(String(workflow.status))) {
      throw new ContinuationBindingError('continuation_self_workflow_terminal')
    }
    const workflowDomain = continuationDomainForWorkflowKind(workflow.kind)
    if (workflowDomain !== 'generic' && evidence.domain === 'generic') {
      evidence = { ...evidence, domain: workflowDomain }
    } else if (workflowDomain !== 'generic' && workflowDomain !== evidence.domain) {
      throw new ContinuationBindingError('continuation_source_domain_mismatch')
    }
  }

  return normalizeContinuationBinding({
    v: 1,
    origin: 'self_continue',
    source: { kind: 'turn', id: sourceTurnId },
    conversationId,
    domain: evidence.domain,
    event: 'deadline_resume',
    ...(evidence.workflowRunId ? { workflowRunId: evidence.workflowRunId } : {}),
    authorityRef: evidence.authorityRef,
    directive: { kind: 'deadline_resume', version: 1 },
    expected: {
      sourceStatus: ['running', 'done'],
      ...(workflow ? {
        workflowKind: workflow.kind,
        workflowStateVersion: workflow.stateVersion,
      } : {}),
    },
  })
}

/**
 * Load one persisted Plan-Driver step and construct its identity-only binding.
 * The caller supplies message-row ids, never their text; bind/claim revalidate
 * and render all execution prose from the database.
 */
export async function buildPlanStepContinuationBinding(input: {
  stepId: string
  conversationId: string
  steeringMessageIds?: string[]
}): Promise<ContinuationBindingV1> {
  const stepId = clean(input.stepId, 'stepId')
  const conversationId = clean(input.conversationId, 'conversationId')
  const step = await db().agentPlanStep.findUnique({
    where: { id: stepId },
    select: {
      id: true, planId: true, toolName: true, status: true, attemptCount: true,
      plan: {
        select: {
          id: true, conversationId: true, workflowRunId: true,
        },
      },
    },
  })
  if (!step || !step.plan) throw new ContinuationBindingError('continuation_source_not_found')
  if (step.plan.conversationId !== conversationId) {
    throw new ContinuationBindingError('continuation_source_conversation_mismatch')
  }
  let workflow: { kind: string; stateVersion: number } | null = null
  if (step.plan.workflowRunId) {
    workflow = await db().workflowRun.findUnique({
      where: { id: step.plan.workflowRunId },
      select: { kind: true, stateVersion: true },
    })
    if (!workflow) throw new ContinuationBindingError('continuation_workflow_missing')
  }
  const toolName = typeof step.toolName === 'string' ? step.toolName : null
  return normalizeContinuationBinding({
    v: 1,
    origin: 'plan_driver',
    source: { kind: 'plan_step', id: stepId },
    conversationId,
    domain: continuationDomainForPlanStep({ workflowKind: workflow?.kind, toolName }),
    event: 'step_dispatch',
    planId: String(step.planId),
    subidentity: `attempt-${Number(step.attemptCount ?? 0) + 1}`,
    ...(step.plan.workflowRunId ? { workflowRunId: String(step.plan.workflowRunId) } : {}),
    directive: { kind: 'plan_step_execute', version: 1 },
    expected: {
      sourceStatus: ['running'],
      sourceType: toolName ?? 'generic',
      ...(workflow ? {
        workflowKind: workflow.kind,
        workflowStateVersion: workflow.stateVersion,
      } : {}),
    },
    ...(input.steeringMessageIds?.length
      ? { steeringMessageIds: input.steeringMessageIds }
      : {}),
  })
}

export type BoundSpecialistBriefTurn = BoundContinuationTurn & {
  conversationId: string
  binding: ContinuationBindingV1
}

/** Internal chat admission for a worker's identity-only specialist source ref. */
export async function createOrReuseSpecialistBriefContinuation(input: {
  pendingActionId: string
  briefIndex: number
}): Promise<BoundSpecialistBriefTurn> {
  const pendingActionId = clean(input.pendingActionId, 'pendingActionId')
  if (!Number.isInteger(input.briefIndex) || input.briefIndex < 0) {
    throw new ContinuationBindingError('continuation_binding_invalid', 'briefIndex')
  }
  const action = await db().agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: {
      id: true, conversationId: true, type: true, status: true,
      workflowRunId: true, payload: true,
    },
  })
  if (!action) throw new ContinuationBindingError('continuation_source_not_found')
  if (action.type !== 'agent_graph_run') {
    throw new ContinuationBindingError('continuation_source_type_mismatch')
  }
  const conversationId = clean(action.conversationId, 'pendingAction.conversationId')
  const payload = action.payload && typeof action.payload === 'object'
    ? action.payload as Record<string, unknown>
    : {}
  const briefs = Array.isArray(payload.briefs) ? payload.briefs : []
  const brief = briefs[input.briefIndex]
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new ContinuationBindingError('continuation_specialist_brief_missing')
  }
  const sourceDigest = createHash('sha256').update(stableJson(brief)).digest('hex')
  let workflow: { kind: string; stateVersion: number } | null = null
  if (action.workflowRunId) {
    workflow = await db().workflowRun.findUnique({
      where: { id: action.workflowRunId },
      select: { kind: true, stateVersion: true },
    })
    if (!workflow) throw new ContinuationBindingError('continuation_workflow_missing')
  }
  const binding = normalizeContinuationBinding({
    v: 1,
    origin: 'specialist',
    source: { kind: 'pending_action', id: pendingActionId },
    conversationId,
    domain: workflow
      ? continuationDomainForWorkflowKind(workflow.kind)
      : continuationDomainForPendingActionType(action.type),
    event: 'specialist_dispatch',
    subidentity: `brief-${input.briefIndex}`,
    sourceDigest,
    ...(action.workflowRunId ? { workflowRunId: String(action.workflowRunId) } : {}),
    directive: { kind: 'specialist_brief_execute', version: 1 },
    expected: {
      // This is a creation precondition, intentionally immutable. Replay finds
      // the deterministic turn before a terminal source status is inspected.
      sourceStatus: ['approved'],
      sourceType: 'agent_graph_run',
      ...(workflow ? {
        workflowKind: workflow.kind,
        workflowStateVersion: workflow.stateVersion,
      } : {}),
    },
  })
  const bound = await bindContinuationTurn({ binding })
  return { ...bound, conversationId, binding }
}

export async function loadContinuationBindingForTurn(
  conversationId: string,
  turnId: string | null | undefined,
): Promise<LoadedContinuationBinding> {
  const normalizedConversationId = conversationId.trim()
  const normalizedTurnId = turnId?.trim() ?? ''
  if (!normalizedTurnId) return { state: 'absent' }
  try {
    const row = await db().agentTurn.findUnique({
      where: { id: normalizedTurnId },
      select: {
        conversationId: true, requestId: true, continuationBinding: true, status: true,
      },
    })
    if (!row || row.continuationBinding == null) return { state: 'absent' }
    if (row.conversationId !== normalizedConversationId) {
      return { state: 'invalid', reason: 'continuation_turn_conversation_mismatch' }
    }
    const binding = normalizeContinuationBinding(row.continuationBinding)
    const requestId = continuationRequestId(binding)
    if (row.requestId !== requestId || binding.conversationId !== normalizedConversationId) {
      return { state: 'invalid', reason: 'continuation_turn_identity_mismatch' }
    }
    return { state: 'bound', binding, requestId, status: String(row.status) }
  } catch (error) {
    return {
      state: 'invalid',
      reason: error instanceof ContinuationBindingError ? error.code : 'continuation_binding_unavailable',
    }
  }
}

export function renderContinuationDirective(
  bindingInput: ContinuationBindingV1,
  context: DirectiveContext = {},
): string {
  const binding = normalizeContinuationBinding(bindingInput)
  const wrapper = '[INTERNAL WORKFLOW CONTINUATION — server-bound control state, NOT an owner-authored message. Never display or quote it as Boss text.]'
  switch (binding.directive.kind) {
    case 'seo_artifact_delivered':
      return `${wrapper}\n[INTERNAL SEO JOB RESULT] Audit action ${binding.source.id} is executed and its durable artifact/card is already delivered. ` +
        'Do not repeat the full server report and never rerun the audit. Add only independently verified critical/high fixes and the first action, then resume the canonical client_seo_batch at its exact next allowed tool.'
    case 'image_artifact_delivered':
      return `${wrapper}\n[INTERNAL IMAGE JOB RESULT] Creative action ${binding.source.id} is executed and its durable image message is already in the conversation. ` +
        'Never regenerate it. First show or refer to that exact persisted preview and ask Boss to confirm it with an ask_user card (ঠিক আছে, পোস্ট রেডি করো / ছবি change চাই). ' +
        'Only after explicit confirmation may you propose a publishing action.'
    case 'open_task_resume': {
      const note = clean(context.openTaskResumeNote, 'openTask.resumeNote')
      return `${wrapper}\n[BOUND OPEN TASK ${binding.source.id}] Resume only this persisted task from its exact next step:\n${note}`
    }
    case 'approved_action_completed':
      return `${wrapper}\nApproved action ${binding.source.id} is durably complete. Do not repeat it; resume its linked workflow at the exact next allowed step.`
    case 'deadline_resume':
      return `${wrapper}\nThe bound predecessor turn ${binding.source.id} reached its deadline. Resume from persisted workflow/checkpoint state; never repeat a completed effect.`
    case 'job_delivery_retry':
      return `${wrapper}\nThe bound job ${binding.source.id} is terminal but its owner delivery is still owed. Read its persisted result and deliver it now; never rerun the job.`
    case 'owner_steering': {
      const prompt = clean(context.ownerSteeringPrompt, 'ownerSteeringPrompt')
      return `${wrapper}\nApply only the exact persisted steering rows bound to predecessor turn ${binding.source.id}:\n${prompt}`
    }
    case 'voice_call_terminal':
      return `${wrapper}\nRead the persisted terminal call source ${binding.source.id} and report that exact outcome; approval is not completion.`
    case 'mac_visual_proof':
      return `${wrapper}\nRead the persisted command/proof source ${binding.source.id}; report the verified outcome and never infer success from a screenshot alone.`
    case 'plan_step_execute': {
      const directive = clean(context.planStepDirective, 'planStepDirective')
      return `${wrapper}\n${directive}`
    }
    case 'specialist_brief_execute': {
      const directive = clean(context.specialistBriefDirective, 'specialistBriefDirective')
      return `${wrapper}\n${directive}`
    }
  }
}

/**
 * The execution claim is a recoverable LEASE, not a one-way latch. If the
 * executor dies after this transaction commits but before `runOwnerTurn` emits
 * a terminal event, nothing ever cleared `continuationExecutionClaimedAt` — so
 * every BullMQ retry hit the non-null claim, returned `observe`, and completed
 * without executing anything: the turn stayed `running` forever and the bound
 * open-task/approval/plan work was permanently lost (Codex P1, PR #847).
 *
 * A retry may therefore RECLAIM a stale lease: the turn is still `running`
 * (no terminal was ever written) and the claim is older than every legitimate
 * executor lifetime — the inline chat route caps at `maxDuration = 800`s and
 * the worker turn is deadline-salvaged well inside that. The reclaim is a CAS
 * on the exact observed timestamp, so two racing retries admit exactly one.
 */
export const CONTINUATION_EXECUTION_LEASE_MS = 20 * 60 * 1000

export async function claimContinuationExecution(input: {
  conversationId: string
  turnId: string
  requestId: string
}): Promise<ContinuationExecutionClaim> {
  const conversationId = clean(input.conversationId, 'conversationId')
  const turnId = clean(input.turnId, 'turnId')
  const requestId = clean(input.requestId, 'requestId')
  return db().$transaction(async (tx: any) => {
    const row = await tx.agentTurn.findUnique({
      where: { id: turnId },
      select: {
        id: true, conversationId: true, requestId: true, continuationBinding: true,
        continuationExecutionClaimedAt: true, status: true,
      },
    })
    if (!row) throw new ContinuationBindingError('continuation_turn_not_found')
    if (row.conversationId !== conversationId) {
      throw new ContinuationBindingError('continuation_turn_conversation_mismatch')
    }
    const binding = normalizeContinuationBinding(row.continuationBinding)
    if (
      row.requestId !== requestId
      || continuationRequestId(binding) !== requestId
      || binding.conversationId !== conversationId
    ) {
      throw new ContinuationBindingError('continuation_turn_identity_mismatch')
    }
    if (row.status !== 'running') {
      return { outcome: 'observe', binding, status: String(row.status) }
    }
    const priorClaim: Date | null = row.continuationExecutionClaimedAt
    const claimIsStale = priorClaim != null
      && Date.now() - priorClaim.getTime() > CONTINUATION_EXECUTION_LEASE_MS
    if (priorClaim && !claimIsStale) {
      // An executor claimed recently; presume it is live and observe.
      return { outcome: 'observe', binding, status: String(row.status) }
    }

    const context = await validateSource(tx, binding, turnId)
    const admitted = await tx.agentTurn.updateMany({
      where: {
        id: turnId,
        conversationId,
        requestId,
        status: 'running',
        // Fresh claim: nobody holds it. Stale reclaim: CAS on the exact dead
        // timestamp so two racing retries admit exactly one.
        continuationExecutionClaimedAt: priorClaim,
      },
      data: { continuationExecutionClaimedAt: new Date() },
    })
    if (admitted.count !== 1) {
      const current = await tx.agentTurn.findUnique({
        where: { id: turnId },
        select: { status: true },
      })
      return { outcome: 'observe', binding, status: String(current?.status ?? 'missing') }
    }

    if (binding.source.kind === 'open_task' && binding.event === 'resume_requested') {
      const moved = await tx.agentOpenTask.updateMany({
        where: { id: binding.source.id, conversationId, status: 'open' },
        data: { status: 'running' },
      })
      if (moved.count !== 1) {
        const task = await tx.agentOpenTask.findUnique({
          where: { id: binding.source.id },
          select: { status: true },
        })
        // A stale reclaim finds the source already moved by the dead executor —
        // `running` is the expected state there, not a failure.
        if (task?.status !== 'running') {
          throw new ContinuationBindingError('continuation_source_claim_failed')
        }
      }
    }

    return {
      outcome: 'claimed',
      binding,
      directive: renderContinuationDirective(binding, context),
      status: 'running',
    }
  })
}

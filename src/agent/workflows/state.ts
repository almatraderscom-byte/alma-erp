/**
 * Durable workflow state (G14 / SPEC-133).
 *
 * The persisted, replayable state of ONE workflow instance, plus the pure reducer
 * that advances it. The reducer is mechanical — it records what happened and
 * enforces legal transitions; it does NOT decide policy (retry/compensation/
 * reconcile are SPEC-135/137/138). Every event carries its own timestamp, so the
 * reducer is deterministic and an instance can be rebuilt by replaying its log
 * (event sourcing; INV-01, no clock inside).
 *
 * Illegal transitions are rejected, state unchanged (fail-closed) — never thrown
 * across the boundary.
 */
import type { ExecutionIdentity } from '@/agent/contracts';
import type { WorkflowTemplate } from './registry';
import type { TemplatePin } from './versioning';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'compensating' | 'compensated';
export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'compensating' | 'compensated' | 'dead_letter';

export interface StepState {
  stepId: string;
  status: StepStatus;
  attempts: number;
  lastError?: string;
}

export interface WorkflowInstanceState {
  instanceId: string;
  identity: ExecutionIdentity;
  pin: TemplatePin;
  status: WorkflowStatus;
  /** index into the template's steps of the current step. */
  cursor: number;
  steps: StepState[];
  createdAtMs: number;
  updatedAtMs: number;
}

export type WorkflowEvent =
  | { type: 'STEP_STARTED'; stepId: string; atMs: number }
  | { type: 'STEP_COMPLETED'; stepId: string; atMs: number }
  | { type: 'STEP_FAILED'; stepId: string; error: string; atMs: number }
  | { type: 'WORKFLOW_FAILED'; atMs: number };

export const STATE_REASON_CODES = {
  UNKNOWN_STEP: 'WF_UNKNOWN_STEP',
  NOT_CURRENT_STEP: 'WF_NOT_CURRENT_STEP',
  ILLEGAL_TRANSITION: 'WF_ILLEGAL_TRANSITION',
  ALREADY_TERMINAL: 'WF_ALREADY_TERMINAL',
} as const;

/** Build the initial state for a new instance (all steps pending, cursor 0). */
export function initialState(
  template: WorkflowTemplate,
  pin: TemplatePin,
  identity: ExecutionIdentity,
  instanceId: string,
  nowMs: number,
): WorkflowInstanceState {
  return {
    instanceId,
    identity,
    pin,
    status: 'running',
    cursor: 0,
    steps: template.steps.map((s) => ({ stepId: s.id, status: 'pending', attempts: 0 })),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

const TERMINAL: WorkflowStatus[] = ['completed', 'compensated', 'dead_letter'];

function clone(s: WorkflowInstanceState): WorkflowInstanceState {
  return { ...s, steps: s.steps.map((st) => ({ ...st })) };
}

export type ReduceResult =
  | { ok: true; state: WorkflowInstanceState }
  | { ok: false; reasonCodes: string[] };

/**
 * Apply one event. Returns the new state or a fail-closed rejection with reason
 * codes; the input state is never mutated. Legal transitions only.
 */
export function applyEvent(state: WorkflowInstanceState, event: WorkflowEvent): ReduceResult {
  if (TERMINAL.includes(state.status) || state.status === 'failed') {
    // failed is not strictly terminal (compensation may follow) but forbids step progress
    if (event.type !== 'WORKFLOW_FAILED' && state.status !== 'failed') {
      return { ok: false, reasonCodes: [STATE_REASON_CODES.ALREADY_TERMINAL] };
    }
  }

  if (event.type === 'WORKFLOW_FAILED') {
    const next = clone(state);
    next.status = 'failed';
    next.updatedAtMs = event.atMs;
    return { ok: true, state: next };
  }

  const idx = state.steps.findIndex((s) => s.stepId === event.stepId);
  if (idx === -1) return { ok: false, reasonCodes: [STATE_REASON_CODES.UNKNOWN_STEP] };
  // Step events only apply to the current cursor step.
  if (idx !== state.cursor) return { ok: false, reasonCodes: [STATE_REASON_CODES.NOT_CURRENT_STEP] };

  const cur = state.steps[idx];
  const next = clone(state);
  const nstep = next.steps[idx];

  switch (event.type) {
    case 'STEP_STARTED':
      if (cur.status !== 'pending' && cur.status !== 'failed') {
        return { ok: false, reasonCodes: [STATE_REASON_CODES.ILLEGAL_TRANSITION] };
      }
      nstep.status = 'running';
      nstep.attempts += 1;
      break;
    case 'STEP_COMPLETED':
      if (cur.status !== 'running') return { ok: false, reasonCodes: [STATE_REASON_CODES.ILLEGAL_TRANSITION] };
      nstep.status = 'completed';
      next.cursor += 1;
      if (next.cursor >= next.steps.length) next.status = 'completed';
      break;
    case 'STEP_FAILED':
      if (cur.status !== 'running') return { ok: false, reasonCodes: [STATE_REASON_CODES.ILLEGAL_TRANSITION] };
      nstep.status = 'failed';
      nstep.lastError = event.error;
      // Workflow-level decision (retry / fail / compensate) is a later spec; the
      // reducer just records the step failure and keeps the workflow running.
      break;
  }
  next.updatedAtMs = event.atMs;
  return { ok: true, state: next };
}

/** Replay a log of events onto the initial state; stops at the first rejection. */
export function replay(initial: WorkflowInstanceState, events: WorkflowEvent[]): ReduceResult {
  let state = initial;
  for (const e of events) {
    const r = applyEvent(state, e);
    if (!r.ok) return r;
    state = r.state;
  }
  return { ok: true, state };
}

/** The current step id, or null if the workflow has no more steps. */
export function currentStepId(state: WorkflowInstanceState): string | null {
  return state.steps[state.cursor]?.stepId ?? null;
}

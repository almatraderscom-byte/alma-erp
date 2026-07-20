/**
 * Structured active-session state (G06 / SPEC-052).
 *
 * The live state of one conversation/workflow — status, current step, and typed
 * variables — keyed by correlation id. Updates are copy-on-write (a new snapshot
 * per change) so state is never mutated in place. Deterministic (caller supplies
 * time). No LLM, no I/O.
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export const SESSION_STATUSES = ['active', 'waiting_approval', 'completed', 'failed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionState {
  correlationId: string;
  identity: ExecutionIdentity;
  status: SessionStatus;
  currentStep: string;
  variables: Record<string, string>;
  updatedAtMs: number;
}

export const sessionStateSchema: z.ZodType<SessionState> = z.object({
  correlationId: z.string().min(1),
  identity: executionIdentitySchema,
  status: z.enum(SESSION_STATUSES),
  currentStep: z.string(),
  variables: z.record(z.string()),
  updatedAtMs: z.number().int().nonnegative(),
}) as z.ZodType<SessionState>;

export class SessionStateStore {
  private readonly states = new Map<string, SessionState>();

  put(state: SessionState): void {
    const parsed = sessionStateSchema.safeParse(state);
    if (!parsed.success) throw new Error(`invalid SessionState: ${parsed.error.issues[0]?.message}`);
    this.states.set(state.correlationId, { ...(parsed.data as SessionState) });
  }

  get(correlationId: string): SessionState | null {
    const s = this.states.get(correlationId);
    return s ? { ...s } : null;
  }

  /** Copy-on-write update — returns a NEW snapshot, never mutates the stored one. */
  update(correlationId: string, patch: Partial<Pick<SessionState, 'status' | 'currentStep' | 'variables'>>, atMs: number): SessionState | null {
    const cur = this.states.get(correlationId);
    if (!cur) return null;
    const next: SessionState = {
      ...cur,
      ...('status' in patch ? { status: patch.status! } : {}),
      ...('currentStep' in patch ? { currentStep: patch.currentStep! } : {}),
      variables: patch.variables ? { ...cur.variables, ...patch.variables } : cur.variables,
      updatedAtMs: atMs,
    };
    this.put(next);
    return { ...next };
  }
}

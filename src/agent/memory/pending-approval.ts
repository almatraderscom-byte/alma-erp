/**
 * Pending-decision and approval state (G06 / SPEC-053).
 *
 * Records actions that need owner approval before they run (money moves,
 * destructive ops — see G02 risk). Fail-closed: an action is actionable ONLY
 * after an explicit approval; anything not approved (pending or rejected) is not.
 * Deterministic (caller supplies time). Enforcement engine is G12; this is the state.
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface PendingApproval {
  id: string;
  identity: ExecutionIdentity;
  action: string;
  riskTier: string;
  status: ApprovalStatus;
  requestedAtMs: number;
  resolvedAtMs: number | null;
}

export const pendingApprovalSchema: z.ZodType<PendingApproval> = z.object({
  id: z.string().min(1),
  identity: executionIdentitySchema,
  action: z.string().min(1),
  riskTier: z.string().min(1),
  status: z.enum(APPROVAL_STATUSES),
  requestedAtMs: z.number().int().nonnegative(),
  resolvedAtMs: z.number().int().nonnegative().nullable(),
}) as z.ZodType<PendingApproval>;

export class ApprovalStore {
  private readonly items = new Map<string, PendingApproval>();

  request(id: string, identity: ExecutionIdentity, action: string, riskTier: string, atMs: number): PendingApproval {
    const rec: PendingApproval = { id, identity, action, riskTier, status: 'pending', requestedAtMs: atMs, resolvedAtMs: null };
    const parsed = pendingApprovalSchema.safeParse(rec);
    if (!parsed.success) throw new Error(`invalid PendingApproval: ${parsed.error.issues[0]?.message}`);
    this.items.set(id, rec);
    return { ...rec };
  }

  resolve(id: string, status: 'approved' | 'rejected', atMs: number): PendingApproval | null {
    const cur = this.items.get(id);
    if (!cur || cur.status !== 'pending') return null; // resolve once; no re-resolving
    const next: PendingApproval = { ...cur, status, resolvedAtMs: atMs };
    this.items.set(id, next);
    return { ...next };
  }

  get(id: string): PendingApproval | null {
    const r = this.items.get(id);
    return r ? { ...r } : null;
  }

  /** Fail-closed: actionable ONLY if explicitly approved. */
  isActionable(id: string): boolean {
    return this.items.get(id)?.status === 'approved';
  }
}

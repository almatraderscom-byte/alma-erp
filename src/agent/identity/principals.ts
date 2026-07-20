/**
 * Authorization principals (G11 / SPEC-101..104).
 *
 * A principal is WHO is acting — the subject a policy decision is made about.
 * Every principal carries a tenant (isolation) and derives from the canonical
 * ExecutionIdentity (G01). The four kinds — human, agent, workflow, credential —
 * are added one spec at a time. Deterministic, no I/O.
 */
import { z } from 'zod';
import type { ExecutionIdentity } from '@/agent/contracts';

export type PrincipalKind = 'human' | 'agent' | 'workflow' | 'credential';

/** SPEC-101 — a human actor (the owner / staff). */
export interface HumanPrincipal {
  kind: 'human';
  tenantId: string;
  actorId: string;
  roles: string[];
}

export const humanPrincipalSchema: z.ZodType<HumanPrincipal> = z.object({
  kind: z.literal('human'),
  tenantId: z.string().min(1),
  actorId: z.string().min(1),
  roles: z.array(z.string()),
}) as z.ZodType<HumanPrincipal>;

/** Build a human principal from an execution identity + granted roles. */
export function humanPrincipal(identity: ExecutionIdentity, roles: string[] = []): HumanPrincipal {
  const p: HumanPrincipal = { kind: 'human', tenantId: identity.tenantId, actorId: identity.actorId, roles: [...roles] };
  const parsed = humanPrincipalSchema.safeParse(p);
  if (!parsed.success) throw new Error(`invalid HumanPrincipal: ${parsed.error.issues[0]?.message}`);
  return parsed.data as HumanPrincipal;
}

/** SPEC-102 — an agent (the AI acting on the owner's behalf). */
export interface AgentPrincipal {
  kind: 'agent';
  tenantId: string;
  agentId: string;
  roles: string[];
}
export const agentPrincipalSchema: z.ZodType<AgentPrincipal> = z.object({
  kind: z.literal('agent'),
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  roles: z.array(z.string()),
}) as z.ZodType<AgentPrincipal>;
export function agentPrincipal(identity: ExecutionIdentity, roles: string[] = []): AgentPrincipal {
  const p: AgentPrincipal = { kind: 'agent', tenantId: identity.tenantId, agentId: identity.agentId ?? identity.actorId, roles: [...roles] };
  const parsed = agentPrincipalSchema.safeParse(p);
  if (!parsed.success) throw new Error(`invalid AgentPrincipal: ${parsed.error.issues[0]?.message}`);
  return parsed.data as AgentPrincipal;
}

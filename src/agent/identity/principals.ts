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

/** SPEC-103 — a workflow acting as a principal (automated multi-step run). */
export interface WorkflowPrincipal {
  kind: 'workflow';
  tenantId: string;
  workflowId: string;
  roles: string[];
}
export const workflowPrincipalSchema: z.ZodType<WorkflowPrincipal> = z.object({
  kind: z.literal('workflow'),
  tenantId: z.string().min(1),
  workflowId: z.string().min(1),
  roles: z.array(z.string()),
}) as z.ZodType<WorkflowPrincipal>;
export function workflowPrincipal(identity: ExecutionIdentity, roles: string[] = []): WorkflowPrincipal {
  const p: WorkflowPrincipal = { kind: 'workflow', tenantId: identity.tenantId, workflowId: identity.workflowId, roles: [...roles] };
  const parsed = workflowPrincipalSchema.safeParse(p);
  if (!parsed.success) throw new Error(`invalid WorkflowPrincipal: ${parsed.error.issues[0]?.message}`);
  return parsed.data as WorkflowPrincipal;
}

/** SPEC-104 — a credential/service-account acting with scoped permissions. */
export interface CredentialPrincipal {
  kind: 'credential';
  tenantId: string;
  credentialId: string;
  scopes: string[];
}
export const credentialPrincipalSchema: z.ZodType<CredentialPrincipal> = z.object({
  kind: z.literal('credential'),
  tenantId: z.string().min(1),
  credentialId: z.string().min(1),
  scopes: z.array(z.string()),
}) as z.ZodType<CredentialPrincipal>;
export function credentialPrincipal(tenantId: string, credentialId: string, scopes: string[] = []): CredentialPrincipal {
  const p: CredentialPrincipal = { kind: 'credential', tenantId, credentialId, scopes: [...scopes] };
  const parsed = credentialPrincipalSchema.safeParse(p);
  if (!parsed.success) throw new Error(`invalid CredentialPrincipal: ${parsed.error.issues[0]?.message}`);
  return parsed.data as CredentialPrincipal;
}

/** The unified principal union (all four kinds). */
export type Principal = HumanPrincipal | AgentPrincipal | WorkflowPrincipal | CredentialPrincipal;

/** Stable identity key for a principal (tenant-scoped). */
export function principalKey(p: Principal): string {
  switch (p.kind) {
    case 'human': return `human:${p.tenantId}:${p.actorId}`;
    case 'agent': return `agent:${p.tenantId}:${p.agentId}`;
    case 'workflow': return `workflow:${p.tenantId}:${p.workflowId}`;
    case 'credential': return `credential:${p.tenantId}:${p.credentialId}`;
  }
}

/** Roles/scopes a principal carries (credentials expose scopes as roles). */
export function principalRoles(p: Principal): string[] {
  return p.kind === 'credential' ? p.scopes : p.roles;
}

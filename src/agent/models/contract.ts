/**
 * Vendor-neutral model invocation contract (G16 / SPEC-151).
 *
 * The typed request/result boundary for every model call. Built on the canonical
 * `ComponentRequest`/`ComponentResult` from `@/agent/contracts`: identity is
 * mandatory, failures are typed discriminated unions with finite reason codes,
 * and there is no ambiguous boolean success.
 */
import { z } from 'zod';
import {
  executionIdentitySchema,
  type ComponentRequest,
  type ComponentResult,
} from '@/agent/contracts';
import type { TokenUsage } from '@/agent/finops/tokens';
import type { AdapterModality, AdapterFinishReason } from '@/agent/providers/runtime/adapter';
import { MODEL_TIERS, type ModelTier } from './tiers';

export const MODEL_FABRIC_CONTRACT_VERSION = '1.0.0' as const;

/** Chars-per-token constant for the deterministic input bound (matches finops heuristic). */
export const CHARS_PER_TOKEN = 4;

export const MODEL_TASK_KINDS = [
  'deterministic', // T0
  'classify', // T1
  'extract', // T1
  'specialist', // T2
  'reason', // T3
  'frontier', // T4
] as const;
export type ModelTaskKind = (typeof MODEL_TASK_KINDS)[number];

/** The bounded call the caller asks the fabric to perform. */
export interface ModelInvocationPayload {
  tier: ModelTier;
  taskKind: ModelTaskKind;
  /** bounded prompt VIEW (INV-07) — full context stays in evidence storage */
  prompt: string;
  responseFormat: AdapterModality;
  /** requested output ceiling; clamped down to the tier's ceiling */
  maxOutputTokens?: number;
  /** capabilities the chosen model must satisfy (SPEC-157 checks these) */
  requiredCapabilities?: string[];
  /** T2 role hint (ops / orders / cs / marketing / research) */
  role?: string;
  /** T4 only: explicit approval token for frontier escalation */
  approvalToken?: string;
  /** T0 only: deterministic template key the resolver dispatches on */
  deterministicKey?: string;
  /** T0 only: variables for the deterministic template */
  deterministicVars?: Record<string, string>;
}

/** The successful value the fabric returns. */
export interface ModelInvocationValue {
  tier: ModelTier;
  provider: string;
  model: string;
  text: string;
  responseFormat: AdapterModality;
  usage: TokenUsage;
  finishReason: AdapterFinishReason;
  /** cost authorization id (present when a provider call happened) */
  authorizationId?: string;
  /** number of provider bindings attempted (1 = no failover) */
  attempts: number;
  /** true when resolved by the deterministic T0 path (no provider call) */
  deterministic: boolean;
}

export type ModelRequest = ComponentRequest<ModelInvocationPayload>;
export type ModelResult = ComponentResult<ModelInvocationValue>;

// ── Runtime validation ──────────────────────────────────────────────────────

export const modelInvocationPayloadSchema: z.ZodType<ModelInvocationPayload> = z.object({
  tier: z.enum(MODEL_TIERS),
  taskKind: z.enum(MODEL_TASK_KINDS),
  prompt: z.string(),
  responseFormat: z.enum(['text', 'json']),
  maxOutputTokens: z.number().int().positive().optional(),
  requiredCapabilities: z.array(z.string().min(1)).optional(),
  role: z.string().min(1).optional(),
  approvalToken: z.string().min(1).optional(),
  deterministicKey: z.string().min(1).optional(),
  deterministicVars: z.record(z.string()).optional(),
}) as z.ZodType<ModelInvocationPayload>;

export const modelRequestSchema = z.object({
  identity: executionIdentitySchema,
  contractVersion: z.string().min(1),
  payload: modelInvocationPayloadSchema,
  policyVersion: z.string().min(1).optional(),
  budgetId: z.string().min(1).optional(),
});

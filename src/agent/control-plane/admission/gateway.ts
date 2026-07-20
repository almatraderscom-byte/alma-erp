/**
 * Single admission gateway (G02 / SPEC-011).
 *
 * The one and only door into the AIOS request path. Every inbound request —
 * Telegram, assistant API, internal cron — enters through `admit()`. The gateway
 * validates the request envelope, establishes a canonical ExecutionIdentity
 * (G01), then runs an ordered list of deterministic admission stages, short-
 * circuiting on the first typed failure. No LLM call lives here (INV-01): model
 * work happens later, pre-authorised by the Cost Governor (G04).
 *
 * Depends only on `@/agent/contracts` (G01). Nothing in ERP imports this.
 */
import { z } from 'zod';
import {
  COMPONENT_CONTRACT_VERSION,
  completed,
  validateRequest,
  type ComponentResult,
  type ExecutionIdentity,
} from '@/agent/contracts';

/** Raw inbound request body (refined by normalization in SPEC-012). */
export interface AdmissionInput {
  channel: string;
  text?: string;
  command?: string;
  payload?: unknown;
}

export const admissionInputSchema: z.ZodType<AdmissionInput> = z.object({
  channel: z.string().min(1),
  text: z.string().optional(),
  command: z.string().optional(),
  payload: z.unknown().optional(),
});

/** Annotations accumulated by stages (classifications land here in 015–018). */
export interface AdmissionAnnotations {
  [key: string]: unknown;
}

/** Mutable-by-copy context threaded through the admission stages. */
export interface AdmissionContext {
  identity: ExecutionIdentity;
  input: AdmissionInput;
  annotations: AdmissionAnnotations;
  evidenceIds: string[];
}

export type StageResult =
  | { ok: true; ctx: AdmissionContext }
  | { ok: false; failure: Extract<ComponentResult<never>, { status: string; reasonCodes: string[] }> };

/** A deterministic admission stage. Pure: same ctx in → same result out. */
export interface AdmissionStage {
  id: string;
  run(ctx: AdmissionContext): StageResult;
}

/** What the gateway returns when a request is admitted. */
export interface AdmissionReceipt {
  admitted: true;
  identity: ExecutionIdentity;
  input: AdmissionInput;
  annotations: AdmissionAnnotations;
  stagesRun: string[];
}

/**
 * The single entry point. Returns a typed ComponentResult — COMPLETED with an
 * AdmissionReceipt when admitted, or a typed failure (never a throw, never a
 * bare boolean). `stages` defaults to the registered admission pipeline.
 */
export function admit(
  raw: unknown,
  stages: AdmissionStage[],
): ComponentResult<AdmissionReceipt> {
  const validated = validateRequest(raw, admissionInputSchema, COMPONENT_CONTRACT_VERSION);
  if (!validated.ok) return validated.failure;

  let ctx: AdmissionContext = {
    identity: validated.request.identity,
    input: validated.request.payload,
    annotations: {},
    evidenceIds: [],
  };

  const stagesRun: string[] = [];
  for (const stage of stages) {
    const r = stage.run(ctx);
    if (!r.ok) return r.failure;
    ctx = r.ctx;
    stagesRun.push(stage.id);
  }

  return completed<AdmissionReceipt>(
    { admitted: true, identity: ctx.identity, input: ctx.input, annotations: ctx.annotations, stagesRun },
    ctx.evidenceIds,
    { admission: '1.0.0' },
  );
}

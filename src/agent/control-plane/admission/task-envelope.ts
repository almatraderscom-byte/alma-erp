/**
 * Structured task envelope (G02 / SPEC-014).
 *
 * The canonical hand-off produced when a request is admitted. Everything the
 * downstream request path needs — Cost Governor (G04), Context Compiler (G05) —
 * is projected into ONE typed, validated envelope, so no downstream stage has to
 * reach back into channel-specific shapes. This is the pinned interface between
 * G02 and the rest of the pipeline.
 */
import { z } from 'zod';
import {
  REASON_CODES,
  completed,
  executionIdentitySchema,
  failure,
  type ComponentResult,
  type ExecutionIdentity,
} from '@/agent/contracts';
import type { AdmissionReceipt } from './gateway';
import { KNOWN_CHANNELS, type Channel, type NormalizedRequest } from './normalize';
import type { FastPathHit } from './fast-path';

/** Classification slots filled by SPEC-015..018 (all optional until they run). */
export interface Classifications {
  intent?: string;
  complexity?: string;
  planningNeed?: string;
  risk?: string;
}

export interface TaskEnvelope {
  identity: ExecutionIdentity;
  channel: Channel;
  text: string;
  command: string | null;
  hasAttachments: boolean;
  fastPath: FastPathHit | null;
  classifications: Classifications;
  contractVersion: string;
}

export const TASK_ENVELOPE_VERSION = '1.0.0' as const;

export const taskEnvelopeSchema: z.ZodType<TaskEnvelope> = z.object({
  identity: executionIdentitySchema,
  channel: z.enum(KNOWN_CHANNELS),
  text: z.string(),
  command: z.string().nullable(),
  hasAttachments: z.boolean(),
  fastPath: z
    .object({ handlerId: z.string(), command: z.string() })
    .nullable(),
  classifications: z.object({
    intent: z.string().optional(),
    complexity: z.string().optional(),
    planningNeed: z.string().optional(),
    risk: z.string().optional(),
  }),
  contractVersion: z.string(),
}) as z.ZodType<TaskEnvelope>;

/**
 * Project an admitted receipt into the canonical envelope. Returns a typed
 * failure if the receipt was not normalized (misuse — normalize is the first
 * admission stage, so a well-formed receipt always carries it).
 */
export function buildEnvelope(receipt: AdmissionReceipt): ComponentResult<TaskEnvelope> {
  const normalized = receipt.annotations.normalized as NormalizedRequest | undefined;
  if (!normalized) {
    return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT]);
  }
  const envelope: TaskEnvelope = {
    identity: receipt.identity,
    channel: normalized.channel,
    text: normalized.text,
    command: normalized.command,
    hasAttachments: normalized.hasAttachments,
    fastPath: (receipt.annotations.fastPath as FastPathHit | null) ?? null,
    classifications: {
      intent: receipt.annotations.intent as string | undefined,
      complexity: receipt.annotations.complexity as string | undefined,
      planningNeed: receipt.annotations.planningNeed as string | undefined,
      risk: receipt.annotations.risk as string | undefined,
    },
    contractVersion: TASK_ENVELOPE_VERSION,
  };
  return completed(envelope, receipt.annotations.evidenceIds as string[] | undefined ?? [], {
    taskEnvelope: TASK_ENVELOPE_VERSION,
  });
}

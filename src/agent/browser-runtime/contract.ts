/**
 * Browser runtime — contract (G15 / SPEC-146).
 *
 * The browser agent is split into three SEPARATE, typed phases so that no single
 * step can both imagine the world and act on it:
 *
 *   PLAN        a bounded, ordered list of intended steps (produced by a model
 *               behind an adapter seam; validated here — never trusted raw).
 *   PERCEPTION  a bounded observation of the CURRENT page: a capped, redacted set
 *               of addressable elements (full detail stays in evidence — INV-07).
 *   ACTION      ONE act that must (a) reference a plan step and (b) target an
 *               element that actually appears in the current perception. An action
 *               that names a non-present element is rejected fail-closed — this is
 *               the structural defense against hallucinated / injected targets.
 *
 * This module is pure types + zod. Deterministic (INV-01): no clock/RNG/IO; the
 * model and the browser driver are seams. Identity rides every phase (INV-02).
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export const BROWSER_CONTRACT_VERSION = '1.0.0' as const;

/** Upper bounds — a browser task is deliberately small and cheap. */
export const MAX_PLAN_STEPS = 32;
export const MAX_INSTRUCTION_BYTES = 4096;
export const MAX_OBSERVED_ELEMENTS = 64;

/** Intent verbs a plan step may express. Closed set (fail-closed). */
export const STEP_INTENTS = ['navigate', 'click', 'type', 'read', 'stop'] as const;
export type StepIntent = (typeof STEP_INTENTS)[number];

/** One intended step. `targetHint` is matched against a perception element label. */
export interface PlanStep {
  stepIndex: number;
  intent: StepIntent;
  /** For click/type/read: the label of the element to act on. */
  targetHint?: string;
  /** For type: the literal text to enter (bounded). */
  text?: string;
  /** For navigate: the destination (bounded). */
  url?: string;
}

export interface BrowserPlan {
  planId: string;
  identity: ExecutionIdentity;
  goalId: string;
  steps: PlanStep[];
}

/** One addressable element the perception exposes to the action phase. */
export interface ObservedElement {
  /** Stable, opaque handle the action targets (NOT a raw selector/secret). */
  ref: string;
  role: string;
  /** Human label used to match a plan step's targetHint. */
  label: string;
}

export interface Observation {
  identity: ExecutionIdentity;
  observedAtMs: number;
  /** Redacted/bounded page URL (host+path only; query/secret stripped upstream). */
  urlRef: string;
  elements: ObservedElement[];
}

/** The single act the action phase emits. */
export type BrowserActionType = 'navigate' | 'click' | 'type' | 'read' | 'stop';

export interface BrowserAction {
  type: BrowserActionType;
  planStepIndex: number;
  targetRef?: string;
  text?: string;
  url?: string;
}

export const BROWSER_REASON_CODES = {
  PLAN_MALFORMED: 'BR_PLAN_MALFORMED',
  OBS_MALFORMED: 'BR_OBS_MALFORMED',
  TOO_MANY_STEPS: 'BR_TOO_MANY_STEPS',
  TOO_MANY_ELEMENTS: 'BR_TOO_MANY_ELEMENTS',
  TARGET_NOT_FOUND: 'BR_TARGET_NOT_IN_PERCEPTION',
  MISSING_TARGET_HINT: 'BR_MISSING_TARGET_HINT',
  CURSOR_OUT_OF_RANGE: 'BR_CURSOR_OUT_OF_RANGE',
  MALFORMED: 'BR_MALFORMED',
} as const;
export type BrowserReasonCode = (typeof BROWSER_REASON_CODES)[keyof typeof BROWSER_REASON_CODES];

// ── zod schemas ─────────────────────────────────────────────────────────────

export const planStepSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  intent: z.enum(STEP_INTENTS),
  targetHint: z.string().min(1).max(512).optional(),
  text: z.string().max(MAX_INSTRUCTION_BYTES).optional(),
  url: z.string().min(1).max(2048).optional(),
});

export const browserPlanSchema = z.object({
  planId: z.string().min(1),
  identity: executionIdentitySchema,
  goalId: z.string().min(1),
  steps: z.array(planStepSchema).max(MAX_PLAN_STEPS),
});

export const observedElementSchema = z.object({
  ref: z.string().min(1).max(256),
  role: z.string().min(1).max(64),
  label: z.string().max(512),
});

export const observationSchema = z.object({
  identity: executionIdentitySchema,
  observedAtMs: z.number().int().nonnegative(),
  urlRef: z.string().min(1).max(2048),
  elements: z.array(observedElementSchema).max(MAX_OBSERVED_ELEMENTS),
});

/**
 * Workflow template registry (G14 / SPEC-131).
 *
 * A durable workflow is a named, versioned, ORDERED sequence of steps — "publish
 * a post", "run payroll", "reconcile an order". This module is the single source
 * of truth for those templates: what steps a workflow has, in what order, which
 * step compensates which (saga rollback, SPEC-138), and whether a step's failure
 * is safe to retry. It is pure data + validation — the runtime (later specs)
 * executes an INSTANCE of a template; the template itself never runs anything.
 *
 * Deterministic, no I/O, no LLM (INV-01). Every template is immutable and
 * versioned; a new version is a new entry, never an edit (durable instances pin
 * the version they started on — SPEC-132).
 */
import { z } from 'zod';

/** How a step's failure should be classified by default (SPEC-135 refines at runtime). */
export type StepFailureMode = 'retryable' | 'terminal' | 'reconcile';

/** One step of a workflow template. */
export interface WorkflowStepDef {
  /** Unique within the template; stable across versions where possible. */
  id: string;
  /** The gateway action this step performs (routed through G13 at runtime). */
  action: string;
  /** Whether this step causes an external side effect (needs idempotency, SPEC-136). */
  sideEffect: boolean;
  /** Default failure handling for this step. */
  onFailure: StepFailureMode;
  /** id of the step that compensates (undoes) this one, if any (SPEC-138). */
  compensates?: string;
}

/** A named, versioned workflow template. */
export interface WorkflowTemplate {
  id: string;
  version: number;
  /** Ordered steps; the runtime executes them in this order. */
  steps: WorkflowStepDef[];
  /** Bounded number of steps (defence against pathological templates). */
  description?: string;
}

export const MAX_STEPS = 64;

export const workflowStepSchema: z.ZodType<WorkflowStepDef> = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  sideEffect: z.boolean(),
  onFailure: z.enum(['retryable', 'terminal', 'reconcile']),
  compensates: z.string().min(1).optional(),
}) as z.ZodType<WorkflowStepDef>;

export const workflowTemplateSchema: z.ZodType<WorkflowTemplate> = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  steps: z.array(workflowStepSchema).min(1).max(MAX_STEPS),
  description: z.string().optional(),
}) as z.ZodType<WorkflowTemplate>;

/**
 * Validate a single template's internal consistency (beyond shape): unique step
 * ids, and every `compensates` target existing within the same template.
 */
export function validateTemplate(t: WorkflowTemplate): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const parsed = workflowTemplateSchema.safeParse(t);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return { ok: false, errors };
  }
  const ids = new Set<string>();
  for (const s of t.steps) {
    if (ids.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  for (const s of t.steps) {
    if (s.compensates && !ids.has(s.compensates)) {
      errors.push(`step "${s.id}" compensates unknown step "${s.compensates}"`);
    }
    // A compensating step must itself be a non-retryable (undo runs once).
    if (s.compensates && s.onFailure === 'retryable') {
      errors.push(`compensating step "${s.id}" must not be retryable`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * An immutable registry of workflow templates keyed by (id, version). Construct
 * from a set of templates; invalid or duplicate entries throw at construction so
 * a bad registry never reaches the runtime.
 */
export class WorkflowTemplateRegistry {
  private readonly byKey: ReadonlyMap<string, WorkflowTemplate>;
  private readonly latestByIdVersion: ReadonlyMap<string, number>;

  constructor(templates: WorkflowTemplate[] = []) {
    const byKey = new Map<string, WorkflowTemplate>();
    const latest = new Map<string, number>();
    for (const t of templates) {
      const { ok, errors } = validateTemplate(t);
      if (!ok) throw new Error(`invalid template ${t.id}@v${t.version}: ${errors[0]}`);
      const key = `${t.id}@${t.version}`;
      if (byKey.has(key)) throw new Error(`duplicate template ${key}`);
      byKey.set(key, Object.freeze({ ...t, steps: t.steps.map((s) => Object.freeze({ ...s })) }));
      latest.set(t.id, Math.max(latest.get(t.id) ?? 0, t.version));
    }
    this.byKey = byKey;
    this.latestByIdVersion = latest;
  }

  /** Get a specific version, or the latest if `version` is omitted. Null if absent. */
  get(id: string, version?: number): WorkflowTemplate | null {
    const v = version ?? this.latestByIdVersion.get(id);
    if (v === undefined) return null;
    return this.byKey.get(`${id}@${v}`) ?? null;
  }

  /** The latest version number for a template id, or null. */
  latestVersion(id: string): number | null {
    return this.latestByIdVersion.get(id) ?? null;
  }

  /** All (id, version) keys present. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }
}

export function workflowTemplateRegistry(templates: WorkflowTemplate[] = []): WorkflowTemplateRegistry {
  return new WorkflowTemplateRegistry(templates);
}

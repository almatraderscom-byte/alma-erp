/**
 * Golden-task dataset (G19 / SPEC-184).
 *
 * A fixed, versioned set of representative business tasks with their EXPECTED
 * outcomes — the ground truth every evaluation (routing, tool-selection, cost)
 * scores against. Pure data + validation; deterministic (INV-01). Cases are
 * hand-authored and stable so eval results are comparable across runs.
 */
import { z } from 'zod';

export interface GoldenTask {
  id: string;
  /** The owner request, in words. */
  input: string;
  expected: {
    /** Expected intent class (for routing eval). */
    intent?: string;
    /** Expected model tier (LIGHT/HEAVY/CRITICAL/FRONTIER). */
    tier?: string;
    /** Tool ids that should be selected. */
    tools?: string[];
    /** Whether the task should succeed end-to-end. */
    succeeds: boolean;
  };
}

const goldenSchema = z.object({
  id: z.string().min(1),
  input: z.string().min(1),
  expected: z.object({
    intent: z.string().optional(),
    tier: z.string().optional(),
    tools: z.array(z.string()).optional(),
    succeeds: z.boolean(),
  }),
});

/** Seed golden tasks — representative ALMA business requests. */
export const GOLDEN_TASKS: GoldenTask[] = [
  { id: 'g-order-status', input: 'What is the status of order 123?', expected: { intent: 'query', tier: 'LIGHT', tools: ['order.read'], succeeds: true } },
  { id: 'g-publish-post', input: 'Publish the Eid sale post to Facebook', expected: { intent: 'action', tier: 'HEAVY', tools: ['facebook.publish'], succeeds: true } },
  { id: 'g-refund', input: 'Refund 500 taka to customer Karim', expected: { intent: 'action', tier: 'CRITICAL', tools: ['wallet.refund'], succeeds: true } },
  { id: 'g-payroll', input: 'Run this month payroll', expected: { intent: 'action', tier: 'CRITICAL', tools: ['payroll.run'], succeeds: true } },
  { id: 'g-research', input: 'Research abaya price trends this week', expected: { intent: 'research', tier: 'HEAVY', tools: ['search.query'], succeeds: true } },
];

export function validateGoldenTasks(tasks: GoldenTask[] = GOLDEN_TASKS): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    if (!goldenSchema.safeParse(t).success) errors.push(`${t.id}: malformed`);
    if (seen.has(t.id)) errors.push(`duplicate ${t.id}`);
    seen.add(t.id);
  }
  return { ok: errors.length === 0, errors };
}

/** Look up a golden task by id. */
export function getGoldenTask(id: string, tasks: GoldenTask[] = GOLDEN_TASKS): GoldenTask | null {
  return tasks.find((t) => t.id === id) ?? null;
}

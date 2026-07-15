/**
 * Shared WorkflowRun status vocabulary — split from workflow-run.ts so the
 * pure-data template layer (workflow-templates.ts) can type against it without
 * importing the prisma-backed service (no import cycle, no DB in unit tests).
 */
export type WorkflowStatus = 'active' | 'waiting_owner' | 'waiting_worker' | 'done' | 'failed' | 'cancelled'

export const TERMINAL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = ['done', 'failed', 'cancelled']

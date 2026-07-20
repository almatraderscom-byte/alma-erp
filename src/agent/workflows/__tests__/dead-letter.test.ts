import { describe, it, expect } from 'vitest';
import { toDeadLetter, allowedRecoveryActions, authorizeRecovery, DEAD_LETTER_REASON_CODES, type DeadLetterEntry } from '../dead-letter';
import { initialState } from '../state';
import { humanPrincipal, agentPrincipal } from '@/agent/identity/principals';
import type { WorkflowTemplate } from '../registry';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const template: WorkflowTemplate = { id: 'x', version: 1, steps: [{ id: 'a', action: 'x', sideEffect: true, onFailure: 'reconcile' }] };
const state = initialState(template, { templateId: 'x', templateVersion: 1 }, identity, 'inst-1', 0);
const entry = (reason: DeadLetterEntry['reason'], uncompensated: string[] = []): DeadLetterEntry =>
  toDeadLetter(state, reason, { uncompensated, enqueuedAtMs: 100 });

describe('toDeadLetter (SPEC-139)', () => {
  it('captures instance, identity, reason and uncompensated effects', () => {
    const e = entry('uncompensatable', ['charge']);
    expect(e).toMatchObject({ instanceId: 'inst-1', reason: 'uncompensatable', uncompensated: ['charge'], enqueuedAtMs: 100 });
    expect(e.identity.tenantId).toBe('alma');
  });
});

describe('allowedRecoveryActions (SPEC-139)', () => {
  it('uncompensatable offers no automatic retry/skip', () => {
    const a = allowedRecoveryActions(entry('uncompensatable', ['charge']));
    expect(a).toEqual(['compensate', 'cancel']);
    expect(a).not.toContain('retry_step');
    expect(a).not.toContain('skip_step');
  });
  it('reconcile_escalated never offers a blind retry', () => {
    expect(allowedRecoveryActions(entry('reconcile_escalated'))).not.toContain('retry_step');
  });
  it('retry_exhausted allows retry/skip/cancel', () => {
    expect(allowedRecoveryActions(entry('retry_exhausted')).sort()).toEqual(['cancel', 'retry_step', 'skip_step']);
  });
  it('terminal_failure allows skip/cancel', () => {
    expect(allowedRecoveryActions(entry('terminal_failure')).sort()).toEqual(['cancel', 'skip_step']);
  });
});

describe('authorizeRecovery (SPEC-139)', () => {
  const boss = humanPrincipal({ ...identity, actorId: 'boss' }, ['owner']);
  it('authorizes a human operator taking an allowed action', () => {
    expect(authorizeRecovery(entry('retry_exhausted'), boss, 'retry_step')).toEqual([]);
  });
  it('rejects an agent operator (recovery is a human action)', () => {
    const bot = agentPrincipal({ ...identity, actorId: 'a', agentId: 'a' }, ['owner']);
    expect(authorizeRecovery(entry('retry_exhausted'), bot, 'retry_step')).toContain(DEAD_LETTER_REASON_CODES.NOT_HUMAN_OPERATOR);
  });
  it('rejects a cross-tenant operator', () => {
    const foreign = humanPrincipal({ ...identity, tenantId: 'other', actorId: 'x' }, ['owner']);
    expect(authorizeRecovery(entry('retry_exhausted'), foreign, 'retry_step')).toContain(DEAD_LETTER_REASON_CODES.CROSS_TENANT_OPERATOR);
  });
  it('rejects a disallowed action for the reason', () => {
    expect(authorizeRecovery(entry('uncompensatable', ['c']), boss, 'retry_step')).toContain(DEAD_LETTER_REASON_CODES.ACTION_NOT_ALLOWED);
  });
});

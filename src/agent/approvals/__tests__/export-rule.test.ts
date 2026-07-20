import { describe, it, expect } from 'vitest';
import { ExportApprovalRule, exportApprovalRule, readRowCount, EXPORT_REASON_CODES } from '../export-rule';
import { AutonomyEngine, type AutonomyInput } from '../../autonomy/states';
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const allow = (action: string): PolicyDecision =>
  decidePolicy({ identity, principal: humanPrincipal(identity, ['owner']), action, resource: { type: 'export', id: 'e', tenantId: 'alma' } }, [rbacLayer([{ role: 'owner', allow: ['*'] }])]);
const input = (action: string, resourceType: string, attributes?: Record<string, unknown>): AutonomyInput => ({
  identity, action: { action, resourceType, resourceId: 'e', attributes }, policyDecision: allow(action),
});
const rule = exportApprovalRule({ autonomousRowCeiling: 100 });

describe('readRowCount (SPEC-116)', () => {
  it('accepts non-negative integers only', () => {
    expect(readRowCount({ rowCount: 50 })).toBe(50);
    expect(readRowCount({ rowCount: -1 })).toBeNull();
    expect(readRowCount({ rowCount: 1.5 })).toBeNull();
    expect(readRowCount(undefined)).toBeNull();
  });
});

describe('ExportApprovalRule (SPEC-116)', () => {
  it('abstains on non-export actions', () => {
    expect(rule.evaluate(input('orders.read', 'order')).effect).toBe('abstain');
  });
  it('autonomous for small internal non-sensitive export', () => {
    const v = rule.evaluate(input('export.run', 'export', { destination: 'internal', rowCount: 50 }));
    expect(v.effect).toBe('autonomous_ok');
    expect(v.reasonCodes).toContain(EXPORT_REASON_CODES.INTERNAL_SMALL_OK);
  });
  it('require_approval for sensitive data regardless', () => {
    expect(rule.evaluate(input('export.run', 'export', { destination: 'internal', rowCount: 1, sensitive: true })).reasonCodes)
      .toContain(EXPORT_REASON_CODES.SENSITIVE_DATA);
  });
  it('require_approval for external / unknown destination (fail-closed)', () => {
    expect(rule.evaluate(input('export.run', 'export', { destination: 'gdrive', rowCount: 1 })).reasonCodes).toContain(EXPORT_REASON_CODES.EXTERNAL_DESTINATION);
    expect(rule.evaluate(input('export.run', 'export', { rowCount: 1 })).reasonCodes).toContain(EXPORT_REASON_CODES.EXTERNAL_DESTINATION);
  });
  it('require_approval when scope unknown or over ceiling', () => {
    expect(rule.evaluate(input('export.run', 'export', { destination: 'internal' })).reasonCodes).toContain(EXPORT_REASON_CODES.SCOPE_UNKNOWN);
    expect(rule.evaluate(input('export.run', 'export', { destination: 'internal', rowCount: 101 })).reasonCodes).toContain(EXPORT_REASON_CODES.OVER_ROW_CEILING);
  });
  it('throws on invalid config', () => {
    expect(() => new ExportApprovalRule({ autonomousRowCeiling: -1 })).toThrow();
  });
});

describe('export through the autonomy engine (SPEC-111 + SPEC-116)', () => {
  const engine = new AutonomyEngine([rule]);
  it('small internal export → AUTONOMOUS', () => {
    expect(engine.decide(input('export.run', 'export', { destination: 'internal', rowCount: 10 })).status).toBe('ALLOWED');
  });
  it('external export → NEEDS_APPROVAL', () => {
    expect(engine.decide(input('export.run', 'export', { destination: 'gdrive', rowCount: 10 })).status).toBe('NEEDS_APPROVAL');
  });
});

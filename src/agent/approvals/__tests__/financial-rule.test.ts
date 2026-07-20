import { describe, it, expect } from 'vitest';
import { FinancialApprovalRule, financialApprovalRule, readAmountNano, FINANCIAL_REASON_CODES } from '../financial-rule';
import { AutonomyEngine, type AutonomyInput } from '../../autonomy/states';
import { decidePolicy, rbacLayer, type PolicyDecision } from '@/agent/policy';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const allow = (action: string): PolicyDecision =>
  decidePolicy(
    { identity, principal: humanPrincipal(identity, ['staff']), action, resource: { type: action.split('.')[0], id: 'x', tenantId: 'alma' } },
    [rbacLayer([{ role: 'staff', allow: ['*'] }])],
  );

const input = (action: string, resourceType: string, attributes?: Record<string, unknown>): AutonomyInput => ({
  identity,
  action: { action, resourceType, resourceId: 'x', attributes },
  policyDecision: allow(action),
});

const CEILING = 100_000_000; // 0.1 USD in nano
const rule = financialApprovalRule({ autonomousCeilingNano: CEILING });

describe('readAmountNano (SPEC-113)', () => {
  it('accepts a whole non-negative nano integer', () => {
    expect(readAmountNano({ amountNano: 5000 })).toBe(5000);
    expect(readAmountNano({ amountNano: 0 })).toBe(0);
  });
  it('rejects floats, negatives, and non-numbers (fail-closed)', () => {
    expect(readAmountNano({ amountNano: 1.5 })).toBeNull();
    expect(readAmountNano({ amountNano: -1 })).toBeNull();
    expect(readAmountNano({ amountNano: '5000' })).toBeNull();
    expect(readAmountNano({})).toBeNull();
    expect(readAmountNano(undefined)).toBeNull();
  });
});

describe('FinancialApprovalRule.evaluate (SPEC-113)', () => {
  it('abstains on a non-financial action', () => {
    expect(rule.evaluate(input('orders.read', 'order')).effect).toBe('abstain');
  });

  it('autonomous_ok for a small, known financial amount within the ceiling', () => {
    const v = rule.evaluate(input('wallet.debit', 'wallet', { amountNano: 50_000 }));
    expect(v.effect).toBe('autonomous_ok');
    expect(v.reasonCodes).toContain(FINANCIAL_REASON_CODES.WITHIN_CEILING);
  });

  it('require_approval over the ceiling', () => {
    const v = rule.evaluate(input('wallet.debit', 'wallet', { amountNano: CEILING + 1 }));
    expect(v.effect).toBe('require_approval');
    expect(v.reasonCodes).toContain(FINANCIAL_REASON_CODES.OVER_CEILING);
  });

  it('require_approval when the amount is unknown/malformed (fail-closed)', () => {
    expect(rule.evaluate(input('wallet.debit', 'wallet')).reasonCodes).toContain(FINANCIAL_REASON_CODES.AMOUNT_UNKNOWN);
    expect(rule.evaluate(input('wallet.debit', 'wallet', { amountNano: 1.5 })).effect).toBe('require_approval');
  });

  it('payroll ALWAYS needs approval, regardless of amount', () => {
    const v = rule.evaluate(input('payroll.run', 'payroll', { amountNano: 1 }));
    expect(v.effect).toBe('require_approval');
    expect(v.reasonCodes).toContain(FINANCIAL_REASON_CODES.ALWAYS_APPROVE);
  });

  it('detects financial by action prefix even for an unknown resource type', () => {
    expect(rule.evaluate(input('transfer.send', 'thing', { amountNano: 50_000 })).effect).toBe('autonomous_ok');
  });

  it('rejects an invalid config', () => {
    expect(() => new FinancialApprovalRule({ autonomousCeilingNano: -1 })).toThrow();
    expect(() => new FinancialApprovalRule({ autonomousCeilingNano: 1.5 })).toThrow();
  });
});

describe('financial rule through the autonomy engine (SPEC-111 + SPEC-113)', () => {
  const engine = new AutonomyEngine([rule]);

  it('small debit → AUTONOMOUS', () => {
    const r = engine.decide(input('wallet.debit', 'wallet', { amountNano: 50_000 }));
    expect(r.status).toBe('ALLOWED');
    if (r.status === 'ALLOWED') expect(r.value.routineBy).toEqual(['financial']);
  });

  it('big debit → NEEDS_APPROVAL', () => {
    const r = engine.decide(input('wallet.debit', 'wallet', { amountNano: CEILING + 1 }));
    expect(r.status).toBe('NEEDS_APPROVAL');
    if (r.status === 'NEEDS_APPROVAL') expect(r.reasonCodes).toContain(FINANCIAL_REASON_CODES.OVER_CEILING);
  });

  it('payroll → NEEDS_APPROVAL even for 1 nano', () => {
    expect(engine.decide(input('payroll.run', 'payroll', { amountNano: 1 })).status).toBe('NEEDS_APPROVAL');
  });

  it('non-financial with only this rule → NEEDS_APPROVAL (unclassified, fail-closed)', () => {
    // abstain from the only rule ⇒ engine fail-closed default asks
    expect(engine.decide(input('orders.read', 'order')).status).toBe('NEEDS_APPROVAL');
  });
});

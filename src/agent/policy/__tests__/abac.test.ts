import { describe, it, expect } from 'vitest';
import { AbacLayer, abacLayer, resolveAttr, evalComparison, ABAC_REASON_CODES, MAX_CONDITION_DEPTH, type AbacRule, type Condition } from '../abac';
import { PolicyEngine, type PolicyEvaluationInput } from '../decision';
import { rbacLayer } from '../rbac';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };

const input = (over: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput => ({
  identity,
  principal: humanPrincipal(identity, ['staff']),
  action: 'wallet.debit',
  resource: { type: 'wallet', id: 'w-1', tenantId: 'alma', attributes: { amountNano: 50_000 } },
  context: { channel: 'telegram' },
  ...over,
});

describe('resolveAttr (SPEC-107)', () => {
  it('resolves nested resource attributes', () => {
    expect(resolveAttr(input(), 'resource.attributes.amountNano')).toBe(50_000);
    expect(resolveAttr(input(), 'resource.type')).toBe('wallet');
    expect(resolveAttr(input(), 'context.channel')).toBe('telegram');
    expect(resolveAttr(input(), 'action')).toBe('wallet.debit');
  });
  it('resolves the virtual principal.roles', () => {
    expect(resolveAttr(input(), 'principal.roles')).toEqual(['staff']);
  });
  it('returns undefined for absent paths', () => {
    expect(resolveAttr(input(), 'resource.attributes.missing')).toBeUndefined();
    expect(resolveAttr(input(), 'nope.nope')).toBeUndefined();
  });
});

describe('evalComparison (SPEC-107)', () => {
  it('numeric comparators', () => {
    expect(evalComparison(5, 'lte', 10)).toBe(true);
    expect(evalComparison(50_000, 'gt', 100_000)).toBe(false);
    expect(evalComparison('x', 'lt', 3)).toBe(false); // non-numeric → no match
  });
  it('eq/ne/exists', () => {
    expect(evalComparison('telegram', 'eq', 'telegram')).toBe(true);
    expect(evalComparison(undefined, 'exists', undefined)).toBe(false);
    expect(evalComparison('x', 'exists', undefined)).toBe(true);
  });
  it('in/nin/contains', () => {
    expect(evalComparison('owner', 'in', ['owner', 'staff'])).toBe(true);
    expect(evalComparison('ghost', 'nin', ['owner'])).toBe(true);
    expect(evalComparison(['a', 'b'], 'contains', 'a')).toBe(true);
    expect(evalComparison('hello', 'contains', 'ell')).toBe(true);
  });
});

describe('AbacLayer.evaluate (SPEC-107)', () => {
  it('permits when a permit rule matches', () => {
    const l = abacLayer([{ id: 'small-debit', effect: 'permit', when: { attr: 'resource.attributes.amountNano', op: 'lte', value: 100_000 } }]);
    const v = l.evaluate(input());
    expect(v.effect).toBe('permit');
    expect(v.reasonCodes).toContain('rule:small-debit');
  });

  it('deny rule overrides a permit rule within the layer', () => {
    const rules: AbacRule[] = [
      { id: 'permit-all', effect: 'permit', when: { attr: 'resource.type', op: 'eq', value: 'wallet' } },
      { id: 'block-big', effect: 'deny', when: { attr: 'resource.attributes.amountNano', op: 'gt', value: 10_000 } },
    ];
    const v = abacLayer(rules).evaluate(input());
    expect(v.effect).toBe('deny');
    expect(v.reasonCodes).toContain('rule:block-big');
  });

  it('abstains when no rule matches (fail-closed)', () => {
    const l = abacLayer([{ id: 'other', effect: 'permit', when: { attr: 'resource.type', op: 'eq', value: 'order' } }]);
    expect(l.evaluate(input()).effect).toBe('abstain');
  });

  it('respects action scoping', () => {
    const l = abacLayer([{ id: 'r', effect: 'permit', actions: ['orders.read'], when: { attr: 'resource.type', op: 'exists' } }]);
    expect(l.evaluate(input({ action: 'wallet.debit' })).effect).toBe('abstain');
    expect(l.evaluate(input({ action: 'orders.read' })).effect).toBe('permit');
  });

  it('evaluates all/any/not composites', () => {
    const when: Condition = { all: [
      { attr: 'context.channel', op: 'eq', value: 'telegram' },
      { any: [ { attr: 'resource.attributes.amountNano', op: 'lt', value: 1000 }, { not: { attr: 'principal.roles', op: 'contains', value: 'ghost' } } ] },
    ] };
    const v = abacLayer([{ id: 'composite', effect: 'permit', when }]).evaluate(input());
    expect(v.effect).toBe('permit');
  });

  it('rejects a malformed rule at construction', () => {
    expect(() => new AbacLayer([{ id: '', effect: 'permit', when: { attr: 'x', op: 'eq' } } as AbacRule])).toThrow();
  });

  it('rejects an over-deep condition tree', () => {
    let cond: Condition = { attr: 'resource.type', op: 'exists' };
    for (let i = 0; i < MAX_CONDITION_DEPTH + 1; i++) cond = { not: cond };
    expect(() => abacLayer([{ id: 'deep', effect: 'permit', when: cond }])).toThrow();
  });
});

describe('ABAC + RBAC through the engine (SPEC-105/106/107)', () => {
  it('RBAC permits and ABAC deny-overrides at the engine level', () => {
    const engine = new PolicyEngine([
      rbacLayer([{ role: 'staff', allow: ['wallet.debit'] }]),
      abacLayer([{ id: 'cap', effect: 'deny', when: { attr: 'resource.attributes.amountNano', op: 'gt', value: 10_000 } }]),
    ]);
    const r = engine.decide(input()); // amount 50k > 10k cap
    expect(r.status).toBe('DENIED');
    if (r.status === 'DENIED') expect(r.reasonCodes).toContain(ABAC_REASON_CODES.RULE_DENY);
  });

  it('RBAC permit + ABAC within cap → ALLOW', () => {
    const engine = new PolicyEngine([
      rbacLayer([{ role: 'staff', allow: ['wallet.debit'] }]),
      abacLayer([{ id: 'cap', effect: 'deny', when: { attr: 'resource.attributes.amountNano', op: 'gt', value: 10_000 } }]),
    ]);
    const r = engine.decide(input({ resource: { type: 'wallet', tenantId: 'alma', attributes: { amountNano: 5_000 } } }));
    expect(r.status).toBe('ALLOWED');
  });
});

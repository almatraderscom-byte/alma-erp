import { describe, it, expect, vi } from 'vitest';
import { isAuthorized, requireAuthorized, runIfAuthorized, runIfAuthorizedAsync } from '../guard';
import { PolicyEngine, decidePolicy, type PolicyDecision, type PolicyDecisionValue, type PolicyEvaluationInput, type PolicyLayer } from '../decision';
import { rbacLayer } from '../rbac';
import { completed, type ComponentResult } from '@/agent/contracts';
import { humanPrincipal } from '@/agent/identity/principals';

const identity = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const input = (roles: string[], action: string): PolicyEvaluationInput => ({
  identity,
  principal: humanPrincipal(identity, roles),
  action,
  resource: { type: 'order', id: 'o-1', tenantId: 'alma' },
});
const engine = new PolicyEngine([rbacLayer([{ role: 'staff', allow: ['orders.read'] }])]);

describe('guard predicates (SPEC-110)', () => {
  it('isAuthorized reflects the decision', () => {
    expect(isAuthorized(engine.decide(input(['staff'], 'orders.read')))).toBe(true);
    expect(isAuthorized(engine.decide(input(['staff'], 'orders.write')))).toBe(false);
  });

  it('requireAuthorized returns value on ALLOW and the failure on DENY', () => {
    const ok = requireAuthorized(engine.decide(input(['staff'], 'orders.read')));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.effect).toBe('ALLOW');

    const no = requireAuthorized(engine.decide(input(['staff'], 'orders.write')));
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.failure.status).toBe('DENIED');
  });
});

describe('runIfAuthorized — fail-closed enforcement (SPEC-110)', () => {
  it('runs the side effect on ALLOW and passes the decision value', () => {
    const sideEffect = vi.fn((_allow: PolicyDecisionValue): ComponentResult<string> => completed('did-it'));
    const r = runIfAuthorized(engine.decide(input(['staff'], 'orders.read')), sideEffect);
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(sideEffect.mock.calls[0][0].effect).toBe('ALLOW');
    expect(r.status).toBe('COMPLETED');
  });

  it('NEVER runs the side effect on DENY and returns the denial untouched', () => {
    const denial = engine.decide(input(['staff'], 'orders.write'));
    const sideEffect = vi.fn((_allow: PolicyDecisionValue): ComponentResult<string> => completed('should-not-run'));
    const r = runIfAuthorized(denial, sideEffect);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(r).toBe(denial);
    expect(r.status).toBe('DENIED');
  });

  it('a cross-tenant denial also blocks the side effect', () => {
    const foreign: PolicyDecision = decidePolicy(
      { ...input(['staff'], 'orders.read'), principal: humanPrincipal({ ...identity, tenantId: 'other' }, ['staff']) },
      [rbacLayer([{ role: 'staff', allow: ['orders.read'] }])],
    );
    const sideEffect = vi.fn((_allow: PolicyDecisionValue): ComponentResult<string> => completed('x'));
    runIfAuthorized(foreign, sideEffect);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('async variant honours the same fail-closed contract', async () => {
    const denied = engine.decide(input([], 'orders.read'));
    const sideEffect = vi.fn(async (): Promise<ComponentResult<string>> => completed('x'));
    const r = await runIfAuthorizedAsync(denied, sideEffect);
    expect(sideEffect).not.toHaveBeenCalled();
    expect(r.status).toBe('DENIED');

    const allowed = engine.decide(input(['staff'], 'orders.read'));
    const r2 = await runIfAuthorizedAsync(allowed, sideEffect);
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(r2.status).toBe('COMPLETED');
  });

  it('a hand-built permit layer flows obligations into the side effect', () => {
    const layer: PolicyLayer = {
      name: 'x',
      evaluate: () => ({ layer: 'x', effect: 'permit', reasonCodes: [], obligations: ['audit'] }),
    };
    const seen: string[] = [];
    runIfAuthorized(decidePolicy(input(['staff'], 'orders.read'), [layer]), (allow) => {
      seen.push(...allow.obligations);
      return completed('ok');
    });
    expect(seen).toContain('audit');
  });
});

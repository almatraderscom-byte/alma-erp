import { describe, it, expect } from 'vitest';
import { invokeModel } from '../fabric';
import { isSuccess } from '@/agent/contracts';
import { createFakeAdapter } from '@/agent/providers/runtime/fake-adapter';
import { createGovernorCostPort } from '../cost-port';
import { InMemoryBudgetStore, type Budget } from '@/agent/budgets/budget';
import { makeRequest, createFakeCostPort } from './_helpers';

// T3 primary binding is google/gemini-3.1-pro (priced in the G03 registry).
const gemini = () => createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'] });

describe('SPEC-155 standard reasoner T3 tier', () => {
  it('reason task → COMPLETED on the head model', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'Boss, আজকের বিক্রি বিশ্লেষণ করো', responseFormat: 'text' }),
      { cost, adapters: [gemini()] },
    );
    expect(isSuccess(res)).toBe(true);
    if (isSuccess(res)) {
      expect(res.value.tier).toBe('T3');
      expect(res.value.model).toBe('gemini-3.1-pro');
    }
  });

  it('rejects non-reason tasks on T3', async () => {
    const cost = createFakeCostPort();
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'classify', prompt: 'x', responseFormat: 'json' }),
      { cost, adapters: [gemini()] },
    );
    expect(res.status).toBe('FAILED_FINAL');
  });
});

describe('SPEC-155 real Cost Governor integration (INV-03, G03+G04)', () => {
  const budgetsFor = (): Budget[] => [
    { scope: 'org', key: 'org:alma:2026-07', limitNanoUsd: 1_000_000_000 }, // $1
    { scope: 'model_call', key: 'model_call:single', limitNanoUsd: 1_000_000_000 },
  ];

  it('reserves worst-case, invokes, then settles actual spend against real budgets', async () => {
    const store = new InMemoryBudgetStore();
    const cost = createGovernorCostPort({ store, budgetsFor });
    const before = store.state(budgetsFor()[0]);
    expect(before.spentNanoUsd).toBe(0);

    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'analyze', responseFormat: 'text' }),
      { cost, adapters: [gemini()] },
    );
    expect(isSuccess(res)).toBe(true);

    const after = store.state(budgetsFor()[0]);
    expect(after.spentNanoUsd).toBeGreaterThan(0); // actual cost committed
    expect(after.reservedNanoUsd).toBe(0); // reservation converted, none dangling
  });

  it('denies when the budget cannot afford the worst case — provider never called', async () => {
    const store = new InMemoryBudgetStore();
    const tiny = (): Budget[] => [{ scope: 'org', key: 'org:tiny', limitNanoUsd: 1 }]; // 1 nano-USD
    const cost = createGovernorCostPort({ store, budgetsFor: tiny });
    const adapter = gemini();
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'analyze a very long request'.repeat(50), responseFormat: 'text' }),
      { cost, adapters: [adapter] },
    );
    expect(res.status).toBe('BUDGET_EXCEEDED');
    expect(adapter.calls).toHaveLength(0);
    expect(store.state(tiny()[0]).spentNanoUsd).toBe(0);
  });

  it('releases the reservation when the provider fails (no dangling spend)', async () => {
    const store = new InMemoryBudgetStore();
    const cost = createGovernorCostPort({ store, budgetsFor });
    const adapter = createFakeAdapter({ provider: 'google', models: ['gemini-3.1-pro'], rules: [{ match: () => true, outcome: { kind: 'TIMEOUT' } }] });
    const res = await invokeModel(
      makeRequest({ tier: 'T3', taskKind: 'reason', prompt: 'x', responseFormat: 'text' }),
      { cost, adapters: [adapter] },
    );
    expect(res.status).toBe('RETRYABLE');
    const st = store.state(budgetsFor()[0]);
    expect(st.spentNanoUsd).toBe(0);
    expect(st.reservedNanoUsd).toBe(0); // released
  });
});

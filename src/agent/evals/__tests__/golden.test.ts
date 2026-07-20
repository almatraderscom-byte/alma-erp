import { describe, it, expect } from 'vitest';
import { GOLDEN_TASKS, validateGoldenTasks, getGoldenTask } from '../golden';

describe('golden-task dataset (SPEC-184)', () => {
  it('the dataset is valid and non-trivial', () => {
    expect(validateGoldenTasks()).toEqual({ ok: true, errors: [] });
    expect(GOLDEN_TASKS.length).toBeGreaterThanOrEqual(5);
  });
  it('every task has a unique id', () => {
    const ids = GOLDEN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('covers CRITICAL money tasks', () => {
    expect(GOLDEN_TASKS.some((t) => t.expected.tier === 'CRITICAL')).toBe(true);
  });
  it('looks up by id', () => {
    expect(getGoldenTask('g-refund')?.expected.tools).toContain('wallet.refund');
    expect(getGoldenTask('nope')).toBeNull();
  });
  it('rejects a malformed / duplicate dataset', () => {
    expect(validateGoldenTasks([{ id: '', input: '', expected: { succeeds: true } }]).ok).toBe(false);
  });
});

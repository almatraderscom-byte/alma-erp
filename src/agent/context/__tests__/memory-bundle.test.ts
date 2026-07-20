import { describe, it, expect } from 'vitest';
import { memoryBundle } from '../../prompts/bundles';

describe('memoryBundle (SPEC-046)', () => {
  it('is a dynamic memory bundle listing items deterministically', () => {
    const b = memoryBundle(['owner prefers Bangla', 'salary is a debit']);
    expect(b.kind).toBe('memory');
    expect(b.cacheable).toBe(false);
    expect(b.content).toContain('- owner prefers Bangla');
    expect(b.content).toContain('- salary is a debit');
  });
  it('is empty content when there is no memory', () => {
    expect(memoryBundle([]).content).toBe('');
  });
  it('is deterministic for the same items', () => {
    expect(memoryBundle(['a', 'b']).content).toBe(memoryBundle(['a', 'b']).content);
  });
});

import { describe, it, expect } from 'vitest';
import { toolSchemaBundle } from '../../prompts/bundles';

describe('toolSchemaBundle (SPEC-047)', () => {
  it('lists tools sorted by name, deterministically', () => {
    const b = toolSchemaBundle([{ name: 'send', schema: '{...}' }, { name: 'ask', schema: '{...}' }]);
    expect(b.kind).toBe('tool_schema');
    expect(b.content.indexOf('ask')).toBeLessThan(b.content.indexOf('send')); // sorted
  });
  it('is empty when no tools are available', () => {
    expect(toolSchemaBundle([]).content).toBe('');
  });
});

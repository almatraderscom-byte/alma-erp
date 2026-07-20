import { describe, it, expect } from 'vitest';
import { RESEARCH_TEMPLATES, researchRegistry, validateResearchTemplates, researchIsReadOnly } from '../research';

describe('research workflow templates (SPEC-177)', () => {
  it('every template is structurally valid', () => {
    expect(validateResearchTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers and resolves', () => {
    expect(researchRegistry().get('research.market_scan')?.version).toBe(1);
  });
  it('research is entirely read-only (no side effects)', () => {
    expect(researchIsReadOnly()).toBe(true);
  });
  it('has a non-empty template set', () => {
    expect(RESEARCH_TEMPLATES.length).toBeGreaterThanOrEqual(1);
  });
});

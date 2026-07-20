import { describe, it, expect } from 'vitest';
import { MARKETING_TEMPLATES, marketingRegistry, validateMarketingTemplates, MARKETING_PUBLISH_POST } from '../marketing';

describe('marketing workflow templates (SPEC-173)', () => {
  it('every template is structurally valid (G14 registry)', () => {
    expect(validateMarketingTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers and resolves by id', () => {
    const reg = marketingRegistry();
    expect(reg.get('marketing.publish_post')?.version).toBe(1);
    expect(reg.get('marketing.generate_creative')).not.toBeNull();
  });
  it('the publish step has a side effect and an unpublish compensator', () => {
    const publish = MARKETING_PUBLISH_POST.steps.find((s) => s.id === 'publish')!;
    expect(publish.sideEffect).toBe(true);
    expect(publish.onFailure).toBe('reconcile');
    const comp = MARKETING_PUBLISH_POST.steps.find((s) => s.compensates === 'publish');
    expect(comp?.id).toBe('unpublish');
  });
  it('drafting via the specialist has no external side effect', () => {
    expect(MARKETING_PUBLISH_POST.steps.find((s) => s.id === 'draft')!.sideEffect).toBe(false);
  });
  it('exposes a non-empty template set', () => {
    expect(MARKETING_TEMPLATES.length).toBeGreaterThanOrEqual(2);
  });
});

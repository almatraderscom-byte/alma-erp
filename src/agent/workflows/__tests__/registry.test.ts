import { describe, it, expect } from 'vitest';
import {
  WorkflowTemplateRegistry, workflowTemplateRegistry, validateTemplate, MAX_STEPS,
  type WorkflowTemplate,
} from '../registry';

const tmpl = (over: Partial<WorkflowTemplate> = {}): WorkflowTemplate => ({
  id: 'publish-post',
  version: 1,
  steps: [
    { id: 'draft', action: 'post.draft', sideEffect: false, onFailure: 'retryable' },
    { id: 'publish', action: 'facebook.publish', sideEffect: true, onFailure: 'reconcile' },
    { id: 'unpublish', action: 'facebook.delete', sideEffect: true, onFailure: 'terminal', compensates: 'publish' },
  ],
  ...over,
});

describe('validateTemplate (SPEC-131)', () => {
  it('accepts a well-formed template', () => {
    expect(validateTemplate(tmpl()).ok).toBe(true);
  });
  it('rejects duplicate step ids', () => {
    const t = tmpl({ steps: [
      { id: 'a', action: 'x', sideEffect: false, onFailure: 'terminal' },
      { id: 'a', action: 'y', sideEffect: false, onFailure: 'terminal' },
    ] });
    expect(validateTemplate(t).errors.join()).toContain('duplicate step id');
  });
  it('rejects a compensates target that does not exist', () => {
    const t = tmpl({ steps: [{ id: 'a', action: 'x', sideEffect: true, onFailure: 'terminal', compensates: 'ghost' }] });
    expect(validateTemplate(t).errors.join()).toContain('unknown step');
  });
  it('rejects a retryable compensating step', () => {
    const t = tmpl({ steps: [
      { id: 'a', action: 'x', sideEffect: true, onFailure: 'reconcile' },
      { id: 'b', action: 'undo', sideEffect: true, onFailure: 'retryable', compensates: 'a' },
    ] });
    expect(validateTemplate(t).errors.join()).toContain('must not be retryable');
  });
  it('rejects an empty step list and one over the bound', () => {
    expect(validateTemplate(tmpl({ steps: [] })).ok).toBe(false);
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({ id: `s${i}`, action: 'x', sideEffect: false, onFailure: 'terminal' as const }));
    expect(validateTemplate(tmpl({ steps: many })).ok).toBe(false);
  });
});

describe('WorkflowTemplateRegistry (SPEC-131)', () => {
  it('gets a specific version and the latest', () => {
    const reg = workflowTemplateRegistry([tmpl({ version: 1 }), tmpl({ version: 3 }), tmpl({ version: 2 })]);
    expect(reg.get('publish-post', 2)?.version).toBe(2);
    expect(reg.get('publish-post')?.version).toBe(3); // latest
    expect(reg.latestVersion('publish-post')).toBe(3);
  });
  it('returns null for unknown id/version', () => {
    const reg = workflowTemplateRegistry([tmpl()]);
    expect(reg.get('nope')).toBeNull();
    expect(reg.get('publish-post', 9)).toBeNull();
    expect(reg.latestVersion('nope')).toBeNull();
  });
  it('throws on an invalid template at construction', () => {
    expect(() => new WorkflowTemplateRegistry([tmpl({ steps: [] })])).toThrow();
  });
  it('throws on a duplicate (id,version)', () => {
    expect(() => new WorkflowTemplateRegistry([tmpl({ version: 1 }), tmpl({ version: 1 })])).toThrow(/duplicate/);
  });
  it('is immutable — returned templates/steps are frozen', () => {
    const reg = workflowTemplateRegistry([tmpl()]);
    const t = reg.get('publish-post')!;
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.steps[0])).toBe(true);
  });
  it('exposes keys', () => {
    const reg = workflowTemplateRegistry([tmpl({ version: 1 }), tmpl({ version: 2 })]);
    expect(reg.keys().sort()).toEqual(['publish-post@1', 'publish-post@2']);
  });
});

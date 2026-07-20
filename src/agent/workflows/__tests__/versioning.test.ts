import { describe, it, expect } from 'vitest';
import { pinAtStart, templateForPin, assertNoVersionDrift, isMigrationAllowed, VERSION_REASON_CODES, type TemplatePin } from '../versioning';
import { workflowTemplateRegistry, type WorkflowTemplate } from '../registry';

const tmpl = (version: number): WorkflowTemplate => ({
  id: 'wf', version, steps: [{ id: 's1', action: 'a', sideEffect: false, onFailure: 'terminal' }],
});
const reg = workflowTemplateRegistry([tmpl(1), tmpl(2), tmpl(3)]);

describe('pinAtStart (SPEC-132)', () => {
  it('pins the latest version by default', () => {
    expect(pinAtStart(reg, 'wf')).toEqual({ templateId: 'wf', templateVersion: 3 });
  });
  it('pins a requested version', () => {
    expect(pinAtStart(reg, 'wf', 2)).toEqual({ templateId: 'wf', templateVersion: 2 });
  });
  it('returns null for an unknown template or version (fail-closed)', () => {
    expect(pinAtStart(reg, 'nope')).toBeNull();
    expect(pinAtStart(reg, 'wf', 9)).toBeNull();
  });
});

describe('templateForPin (SPEC-132)', () => {
  it('resolves the exact pinned template', () => {
    expect(templateForPin(reg, { templateId: 'wf', templateVersion: 2 })?.version).toBe(2);
  });
  it('returns null for a malformed pin or a missing version (never falls back)', () => {
    expect(templateForPin(reg, { templateId: '', templateVersion: 1 } as TemplatePin)).toBeNull();
    expect(templateForPin(reg, { templateId: 'wf', templateVersion: 9 })).toBeNull();
  });
});

describe('assertNoVersionDrift (SPEC-132)', () => {
  const pin: TemplatePin = { templateId: 'wf', templateVersion: 2 };
  it('passes when the presented version matches the pin', () => {
    expect(assertNoVersionDrift(pin, 2)).toEqual([]);
  });
  it('rejects any drift', () => {
    expect(assertNoVersionDrift(pin, 3)).toContain(VERSION_REASON_CODES.VERSION_DRIFT);
    expect(assertNoVersionDrift(pin, 1)).toContain(VERSION_REASON_CODES.VERSION_DRIFT);
  });
  it('rejects a malformed pin', () => {
    expect(assertNoVersionDrift({ templateId: '', templateVersion: 0 } as TemplatePin, 1)).toContain(VERSION_REASON_CODES.MALFORMED_PIN);
  });
});

describe('isMigrationAllowed (SPEC-132)', () => {
  const pin: TemplatePin = { templateId: 'wf', templateVersion: 1 };
  it('denies by default (no silent migration, INV-09)', () => {
    expect(isMigrationAllowed(pin, 2)).toBe(false);
  });
  it('allows an explicit forward migration only', () => {
    expect(isMigrationAllowed(pin, 2, { explicit: true })).toBe(true);
    expect(isMigrationAllowed(pin, 1, { explicit: true })).toBe(false); // not forward
  });
});

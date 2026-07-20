import { describe, it, expect } from 'vitest';
import { EXTERNAL_COMMS_TEMPLATES, externalCommsRegistry, validateExternalCommsTemplates, allSendsReconcile, COMMS_BROADCAST } from '../external-comms';

describe('external communication workflow templates (SPEC-178)', () => {
  it('every template is structurally valid', () => {
    expect(validateExternalCommsTemplates()).toEqual({ ok: true, errors: [] });
  });
  it('registers email + broadcast', () => {
    expect(externalCommsRegistry().get('comms.send_email')).not.toBeNull();
    expect(externalCommsRegistry().get('comms.broadcast')).not.toBeNull();
  });
  it('every outbound send is a reconcilable side effect', () => {
    expect(allSendsReconcile()).toBe(true);
  });
  it('composition/segmentation are side-effect-free', () => {
    expect(COMMS_BROADCAST.steps.filter((s) => s.id !== 'broadcast').every((s) => !s.sideEffect)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { workflowPrincipal } from '../principals';
const id = { tenantId: 'alma', actorId: 'm', workflowId: 'wf-42', stepId: 's', correlationId: 'c' };
describe('workflowPrincipal (SPEC-103)', () => {
  it('builds a workflow principal', () => {
    const p = workflowPrincipal(id, ['automation']);
    expect(p.kind).toBe('workflow');
    expect(p.workflowId).toBe('wf-42');
    expect(p.roles).toEqual(['automation']);
  });
  it('carries tenant', () => { expect(workflowPrincipal({ ...id, tenantId: 'x' }).tenantId).toBe('x'); });
});

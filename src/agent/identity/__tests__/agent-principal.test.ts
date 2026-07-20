import { describe, it, expect } from 'vitest';
import { agentPrincipal } from '../principals';

const id = { tenantId: 'alma', actorId: 'maruf', agentId: 'ops', workflowId: 'wf', stepId: 's', correlationId: 'c' };

describe('agentPrincipal (SPEC-102)', () => {
  it('builds an agent principal', () => {
    const p = agentPrincipal(id, ['cs']);
    expect(p.kind).toBe('agent');
    expect(p.agentId).toBe('ops');
    expect(p.roles).toEqual(['cs']);
  });
  it('falls back to actorId when no agentId', () => {
    expect(agentPrincipal({ ...id, agentId: undefined }).agentId).toBe('maruf');
  });
  it('carries tenant for isolation', () => {
    expect(agentPrincipal({ ...id, tenantId: 't2' }).tenantId).toBe('t2');
  });
});

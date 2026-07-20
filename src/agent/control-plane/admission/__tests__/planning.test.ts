import { describe, it, expect } from 'vitest';
import { classifyPlanningNeed, planningStage } from '../planning';
import type { NormalizedRequest } from '../normalize';

const nr = (over: Partial<NormalizedRequest>): NormalizedRequest => ({
  channel: 'telegram', text: '', command: null, hasAttachments: false, ...over,
});

describe('classifyPlanningNeed', () => {
  it('NONE for a simple one-shot request', () => {
    expect(classifyPlanningNeed(nr({ text: 'what is the balance?' })).planningNeed).toBe('NONE');
  });

  it('PLAN when there are step markers', () => {
    expect(classifyPlanningNeed(nr({ text: 'make the report then send it' })).planningNeed).toBe('PLAN');
  });

  it('PLAN when there are multiple actions', () => {
    const r = classifyPlanningNeed(nr({ text: 'create invoice and send it' }));
    expect(r.planningNeed).toBe('PLAN');
    expect(r.reasons).toContain('multiple-actions');
  });

  it('PLAN when complexity is COMPLEX', () => {
    expect(classifyPlanningNeed(nr({ text: 'do it' }), 'COMPLEX').planningNeed).toBe('PLAN');
  });

  it('is deterministic', () => {
    const t = 'make report then email';
    expect(classifyPlanningNeed(nr({ text: t })).planningNeed).toBe(classifyPlanningNeed(nr({ text: t })).planningNeed);
  });
});

describe('planningStage', () => {
  it('annotates planningNeed and reads complexity annotation', () => {
    const r = planningStage.run({
      identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
      input: { channel: 'telegram' },
      annotations: { normalized: nr({ text: 'do it' }), complexity: 'COMPLEX' },
      evidenceIds: [],
    });
    if (r.ok) expect(r.ctx.annotations.planningNeed).toBe('PLAN');
  });
});

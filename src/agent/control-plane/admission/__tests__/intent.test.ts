import { describe, it, expect } from 'vitest';
import { classifyIntent, deterministicIntentAdapter, intentStage, type IntentAdapter } from '../intent';
import type { NormalizedRequest } from '../normalize';

const nr = (over: Partial<NormalizedRequest>): NormalizedRequest => ({
  channel: 'telegram', text: '', command: null, hasAttachments: false, ...over,
});

describe('deterministic intent classifier (no model)', () => {
  it('classifies a command', () => {
    expect(classifyIntent(nr({ command: 'status', text: '/status' })).intent).toBe('command');
  });
  it('classifies a question (english + bangla starters, or ?)', () => {
    expect(classifyIntent(nr({ text: 'how many orders today' })).intent).toBe('question');
    expect(classifyIntent(nr({ text: 'koto order holo' })).intent).toBe('question');
    expect(classifyIntent(nr({ text: 'stock ready?' })).intent).toBe('question');
  });
  it('classifies a task (imperative verb)', () => {
    expect(classifyIntent(nr({ text: 'send the invoice' })).intent).toBe('task');
    expect(classifyIntent(nr({ text: 'pathao invoice ta' })).intent).toBe('task');
  });
  it('falls back to chitchat / unknown', () => {
    expect(classifyIntent(nr({ text: 'assalamu alaikum' })).intent).toBe('chitchat');
    expect(classifyIntent(nr({ text: '' })).intent).toBe('unknown');
  });
  it('always reports via=deterministic (no model call)', () => {
    expect(classifyIntent(nr({ text: 'hi' })).via).toBe('deterministic');
  });
});

describe('adapter seam', () => {
  it('accepts a pluggable adapter without touching the gateway', () => {
    const stub: IntentAdapter = { id: 'stub', classify: () => ({ intent: 'task', confidence: 0.99, via: 'model' }) };
    expect(classifyIntent(nr({ text: 'anything' }), stub).via).toBe('model');
  });
  it('default adapter id is deterministic', () => {
    expect(deterministicIntentAdapter.id).toBe('deterministic');
  });
});

describe('intentStage', () => {
  it('annotates intent onto the context', () => {
    const r = intentStage.run({
      identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
      input: { channel: 'telegram' },
      annotations: { normalized: nr({ text: 'how are you?' }) },
      evidenceIds: [],
    });
    if (r.ok) expect(r.ctx.annotations.intent).toBe('question');
  });
});

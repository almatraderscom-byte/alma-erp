import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyTool, guardToolCall, enforcedExecuteTool, enforcementEnabled } from '../enforced-tool-runner';

const identity = { tenantId: 'alma', actorId: 'owner', agentId: 'alma-bot', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const g = (toolName: string, attributes?: Record<string, unknown>, model = 'gemini-3.1-pro') =>
  guardToolCall({ identity, model, toolName, attributes });

describe('classifyTool (model-agnostic action classes)', () => {
  it('maps tools to the right sensitivity class', () => {
    expect(classifyTool('wallet_refund').klass).toBe('financial');
    expect(classifyTool('facebook_publish').klass).toBe('publishing');
    expect(classifyTool('staff_fire').klass).toBe('hr');
    expect(classifyTool('export_customers').klass).toBe('export');
    expect(classifyTool('order_lookup').klass).toBe('routine');
  });
});

describe('guardToolCall — every model forced through the same guardrails', () => {
  it('a routine read runs autonomously', () => {
    const d = g('order_lookup');
    expect(d.allow).toBe(true);
  });
  it('a money action NEEDS_APPROVAL (ceiling 0 → always ask)', () => {
    const d = g('wallet_refund', { amountNano: 5000 });
    expect(d.allow).toBe(false);
    if (!d.allow) { expect(d.status).toBe('NEEDS_APPROVAL'); expect(d.klass).toBe('financial'); }
  });
  it('a public publish NEEDS_APPROVAL', () => {
    const d = g('facebook_publish', { audience: 'public' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.status).toBe('NEEDS_APPROVAL');
  });
  it('the SAME decision holds regardless of which model asked', () => {
    for (const m of ['gemini-3.1-pro', 'claude-opus-4-8', 'or-deepseek-v4-flash', 'or-qwen3-max']) {
      const d = guardToolCall({ identity, model: m, toolName: 'wallet_refund', attributes: { amountNano: 9999 } });
      expect(d.allow).toBe(false); // no model can bypass
    }
  });
  it('unknown money amount fails closed (asks)', () => {
    expect(g('payroll_run').allow).toBe(false);
  });
});

describe('enforcedExecuteTool — flag gates production behaviour', () => {
  const OLD = process.env.AIOS_ENFORCE;
  afterEach(() => { process.env.AIOS_ENFORCE = OLD; });

  it('OFF (default) → runs the real tool unchanged', async () => {
    process.env.AIOS_ENFORCE = '';
    expect(enforcementEnabled()).toBe(false);
    const r = await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'wallet_refund', attributes: { amountNano: 5000 } }, async () => ({ success: true, ran: true }));
    expect(r).toEqual({ success: true, ran: true });
  });

  it('ON → blocks a sensitive call and does NOT run the real tool', async () => {
    process.env.AIOS_ENFORCE = '1';
    let ran = false;
    const r = await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'wallet_refund', attributes: { amountNano: 5000 } }, async () => { ran = true; return { success: true }; });
    expect(ran).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('needs_approval');
  });

  it('ON → runs a routine tool for real', async () => {
    process.env.AIOS_ENFORCE = '1';
    let ran = false;
    await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'order_lookup' }, async () => { ran = true; return { success: true }; });
    expect(ran).toBe(true);
  });
});

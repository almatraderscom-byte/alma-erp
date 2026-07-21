import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyTool, guardToolCall, enforcedExecuteTool, enforcementEnabled } from '../enforced-tool-runner';

const identity = { tenantId: 'alma', actorId: 'owner', agentId: 'alma-bot', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const g = (toolName: string, attributes?: Record<string, unknown>, model = 'gemini-3.1-pro') =>
  guardToolCall({ identity, model, toolName, attributes });

describe('classifyTool (model-agnostic action classes)', () => {
  it('uses exact registered names, never broad substrings', () => {
    expect(classifyTool('send_whatsapp').klass).toBe('publishing');
    // These consume an already-visible canonical approval; a second AIOS card
    // would be duplicate approval, so this extra door treats them as routine.
    expect(classifyTool('approve_pending_dispatch').klass).toBe('routine');
    expect(classifyTool('approve_pending_staff_message').klass).toBe('routine');
    expect(classifyTool('get_fb_recent_posts').klass).toBe('routine');
    expect(classifyTool('get_unanswered_comments').klass).toBe('routine');
    expect(classifyTool('get_expense_summary').klass).toBe('routine');
    expect(classifyTool('read_screenshot').klass).toBe('routine');
    expect(classifyTool('meta_ads_get_ad_accounts').klass).toBe('routine');
  });

  it('fails open for an unknown name so the extra door cannot break a turn', () => {
    expect(classifyTool('future_internal_context_tool').klass).toBe('routine');
    expect(g('future_internal_context_tool').allow).toBe(true);
  });
});

describe('guardToolCall — every model forced through the same guardrails', () => {
  it('a routine read runs autonomously', () => {
    const d = g('order_lookup');
    expect(d.allow).toBe(true);
  });
  it('a public publish NEEDS_APPROVAL', () => {
    const d = g('send_whatsapp', { audience: 'external' });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.status).toBe('NEEDS_APPROVAL');
  });
  it('the SAME decision holds regardless of which model asked', () => {
    for (const m of ['gemini-3.1-pro', 'claude-opus-4-8', 'or-deepseek-v4-flash', 'or-qwen3-max']) {
      const d = guardToolCall({ identity, model: m, toolName: 'send_whatsapp', attributes: { audience: 'external' } });
      expect(d.allow).toBe(false); // no model can bypass
    }
  });
  it('a natively-staged urgent call creates only its canonical approval', () => {
    expect(g('send_urgent_alert', { tier: 3 }).allow).toBe(true);
    expect(g('send_urgent_alert', { tier: 2 }).allow).toBe(false);
  });
});

describe('enforcedExecuteTool — flag gates production behaviour', () => {
  const OLD = process.env.AIOS_ENFORCE;
  afterEach(() => { process.env.AIOS_ENFORCE = OLD; });

  it('OFF (default) → runs the real tool unchanged', async () => {
    process.env.AIOS_ENFORCE = '';
    expect(enforcementEnabled()).toBe(false);
    const r = await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'send_whatsapp' }, async () => ({ success: true, ran: true }));
    expect(r).toEqual({ success: true, ran: true });
  });

  it('ON → blocks a sensitive call and does NOT run the real tool', async () => {
    process.env.AIOS_ENFORCE = '1';
    let ran = false;
    const r = await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'send_whatsapp' }, async () => { ran = true; return { success: true }; });
    expect(ran).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('needs_approval');
  });

  it('ON → runs a routine tool for real', async () => {
    process.env.AIOS_ENFORCE = '1';
    let ran = false;
    await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'read_screenshot' }, async () => { ran = true; return { success: true }; });
    expect(ran).toBe(true);
  });

  it('ON → a benign tool executes exactly once (no retry/double-run trigger)', async () => {
    process.env.AIOS_ENFORCE = 'true';
    let executions = 0;
    const result = await enforcedExecuteTool(
      { identity, model: 'or-qwen3-max', toolName: 'get_unanswered_comments' },
      async () => { executions += 1; return { success: true, replyCount: 1 }; },
    );
    expect(executions).toBe(1);
    expect(result).toEqual({ success: true, replyCount: 1 });
  });
});

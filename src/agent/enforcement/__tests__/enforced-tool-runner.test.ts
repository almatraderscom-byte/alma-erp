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

  it('fails CLOSED for an unknown name — held for owner approval (audit P0-4)', () => {
    expect(classifyTool('future_internal_context_tool').klass).toBe('unknown');
    const d = g('future_internal_context_tool');
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.status).toBe('NEEDS_APPROVAL');
      expect(d.reasonCodes).toContain('UNKNOWN_TOOL');
    }
  });

  it('derives the class of a high-risk direct write from the capability manifest', () => {
    // wa domain, high-risk write, not in the static allowlist by accident? It
    // is — but whatsapp_call proves the allowlist; live_browser_act proves the
    // documented exemption; set_autonomy_policy proves unmapped-high-risk hold.
    expect(classifyTool('live_browser_act').klass).toBe('routine'); // documented exemption
    expect(classifyTool('set_autonomy_policy').klass).toBe('unknown'); // master switch ⇒ hold
    const d = g('set_autonomy_policy', { enabled: false });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.status).toBe('NEEDS_APPROVAL');
  });

  it('manifest read/stage tools stay routine (no double approval for staged cards)', () => {
    expect(classifyTool('get_expense_summary').klass).toBe('routine'); // read
    expect(classifyTool('save_memory').klass).toBe('routine'); // low-risk write
  });
});

describe('guardToolCall — every model forced through the same guardrails', () => {
  it('a routine read runs autonomously', () => {
    const d = g('get_expense_summary');
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

  it('ON by default (audit P0-4: production enforcement defaults to ON)', async () => {
    process.env.AIOS_ENFORCE = '';
    expect(enforcementEnabled()).toBe(true);
    let ran = false;
    const r = await enforcedExecuteTool({ identity, model: 'gemini-3.1-pro', toolName: 'send_whatsapp' }, async () => { ran = true; return { success: true }; });
    expect(ran).toBe(false);
    expect((r as { errorCode: string }).errorCode).toBe('needs_approval');
  });

  it('explicit opt-out (AIOS_ENFORCE=off) → runs the real tool unchanged', async () => {
    process.env.AIOS_ENFORCE = 'off';
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

import { describe, it, expect } from 'vitest';
import { assertNoHeadToolLoop, isHeadInvocation, MAX_HEAD_TOOL_CALLS, type ToolLoopClaim } from '../head-tool-loop-guard';
import { isSuccess } from '@/agent/contracts';

const claim = (over: Partial<ToolLoopClaim> = {}): ToolLoopClaim => ({ role: 'worker', tier: 'T2', toolCalls: 0, ...over });

describe('SPEC-169 head-model tool-loop prohibition', () => {
  it('the head does zero tool calls (MAX_HEAD_TOOL_CALLS = 0)', () => {
    expect(MAX_HEAD_TOOL_CALLS).toBe(0);
  });

  it('a head-role invocation running a tool loop is forbidden', () => {
    const res = assertNoHeadToolLoop(claim({ role: 'head', tier: 'T3', toolCalls: 3 }));
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('HEAD_TOOL_LOOP_FORBIDDEN');
  });

  it('a frontier (T4) invocation can NEVER run a tool loop, even labelled worker', () => {
    expect(isHeadInvocation('worker', 'T4')).toBe(true);
    const res = assertNoHeadToolLoop(claim({ role: 'worker', tier: 'T4', toolCalls: 1 }));
    expect(res.status).toBe('FAILED_FINAL');
    if (!isSuccess(res)) expect(res.reasonCodes).toContain('HEAD_TOOL_LOOP_FORBIDDEN');
  });

  it('the head planning with zero tool calls is allowed', () => {
    expect(assertNoHeadToolLoop(claim({ role: 'head', tier: 'T4', toolCalls: 0 })).status).toBe('COMPLETED');
  });

  it('workers on non-frontier tiers may run tool loops freely', () => {
    expect(assertNoHeadToolLoop(claim({ role: 'worker', tier: 'T1', toolCalls: 10 })).status).toBe('COMPLETED');
    expect(assertNoHeadToolLoop(claim({ role: 'worker', tier: 'T3', toolCalls: 5 })).status).toBe('COMPLETED');
  });

  it('rejects malformed (negative / non-integer) tool-call counts', () => {
    expect(assertNoHeadToolLoop(claim({ toolCalls: -1 })).status).toBe('FAILED_FINAL');
    expect(assertNoHeadToolLoop(claim({ toolCalls: 1.5 })).status).toBe('FAILED_FINAL');
  });

  it('isHeadInvocation: head role OR frontier tier', () => {
    expect(isHeadInvocation('head', 'T2')).toBe(true);
    expect(isHeadInvocation('worker', 'T4')).toBe(true);
    expect(isHeadInvocation('worker', 'T3')).toBe(false);
  });
});

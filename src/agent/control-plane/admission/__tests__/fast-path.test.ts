import { describe, it, expect } from 'vitest';
import { FAST_PATH_COMMANDS, fastPathStage, resolveFastPath } from '../fast-path';
import type { AdmissionContext } from '../gateway';

describe('resolveFastPath', () => {
  it('routes known commands to a handler with no model call', () => {
    expect(resolveFastPath({ command: 'status' })?.handlerId).toBe('handler.status');
    expect(resolveFastPath({ command: 'help' })?.handlerId).toBe('handler.help');
  });

  it('falls through (null) for unknown or missing command', () => {
    expect(resolveFastPath({ command: 'unknown-cmd' })).toBeNull();
    expect(resolveFastPath({ command: null })).toBeNull();
  });

  it('every mapped command points at a handler.* id', () => {
    for (const [cmd, h] of Object.entries(FAST_PATH_COMMANDS)) {
      expect(h).toMatch(/^handler\./);
      expect(cmd).toBe(cmd.toLowerCase());
    }
  });
});

describe('fastPathStage', () => {
  const ctx = (command: string | null): AdmissionContext => ({
    identity: { tenantId: 't', actorId: 'a', workflowId: 'w', stepId: 's', correlationId: 'c' },
    input: { channel: 'telegram' },
    annotations: { normalized: { channel: 'telegram', text: '', command, hasAttachments: false } },
    evidenceIds: [],
  });

  it('annotates a fast-path hit for a known command', () => {
    const r = fastPathStage.run(ctx('status'));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ctx.annotations.fastPath as { handlerId: string }).handlerId).toBe('handler.status');
  });

  it('annotates null (fall through) for unknown command', () => {
    const r = fastPathStage.run(ctx('freeform question'));
    if (r.ok) expect(r.ctx.annotations.fastPath).toBeNull();
  });
});

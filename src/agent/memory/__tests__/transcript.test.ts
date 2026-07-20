import { describe, it, expect } from 'vitest';
import { ConversationTranscript, transcriptEntrySchema, type TranscriptEntry } from '../transcript';

const id = { tenantId: 'alma', actorId: 'maruf', workflowId: 'wf', stepId: 's', correlationId: 'c' };
const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id: 'e1', role: 'owner', content: 'hi', identity: id, atMs: 1000, ...over,
});

describe('ConversationTranscript (SPEC-051)', () => {
  it('appends and preserves order', () => {
    const t = new ConversationTranscript();
    t.append(entry({ id: 'a' })); t.append(entry({ id: 'b', role: 'agent' }));
    expect(t.entries().map((e) => e.id)).toEqual(['a', 'b']);
    expect(t.size()).toBe(2);
  });
  it('rejects an invalid entry (fail-closed)', () => {
    const t = new ConversationTranscript();
    expect(() => t.append(entry({ role: 'hacker' as never }))).toThrow();
  });
  it('is immutable — entries() copy cannot mutate the log', () => {
    const t = new ConversationTranscript();
    t.append(entry());
    const copy = t.entries(); copy[0].content = 'TAMPERED'; copy.push(entry({ id: 'x' }));
    expect(t.entries()[0].content).toBe('hi');
    expect(t.size()).toBe(1);
  });
  it('appended entries are frozen (no in-place mutation)', () => {
    const t = new ConversationTranscript();
    const e = t.append(entry());
    expect(() => { (e as { content: string }).content = 'x'; }).toThrow();
  });
  it('filters by tenant', () => {
    const t = new ConversationTranscript();
    t.append(entry({ id: 'a' }));
    t.append(entry({ id: 'b', identity: { ...id, tenantId: 'other' } }));
    expect(t.forTenant('alma').map((e) => e.id)).toEqual(['a']);
  });
  it('schema validates roles', () => {
    expect(transcriptEntrySchema.safeParse(entry()).success).toBe(true);
  });
});

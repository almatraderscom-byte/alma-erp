import { describe, it, expect } from 'vitest';
import { isSuccess, type ExecutionIdentity } from '@/agent/contracts';
import {
  compactObservation,
  isSecretLabel,
  redactLabel,
  redactUrl,
  REDACTED,
  OBSERVATION_REASON_CODES,
  type RawSnapshot,
  type CompactionCaps,
} from '../observation-state';

const identity = (): ExecutionIdentity => ({
  tenantId: 'alma',
  actorId: 'maruf',
  workflowId: 'wf',
  stepId: 's',
  correlationId: 'c',
});

const caps: CompactionCaps = { maxElements: 3, maxLabelChars: 20, maxBytes: 4096 };

const snap = (elements: RawSnapshot['elements'], rawUrl = 'https://x.com/p?token=abc#frag'): RawSnapshot => ({
  identity: identity(),
  observedAtMs: 1000,
  rawUrl,
  elements,
});

describe('secret redaction (SPEC-147)', () => {
  it('detects secret-shaped labels', () => {
    expect(isSecretLabel('Password')).toBe(true);
    expect(isSecretLabel('bearer eyJabcdef.ghijklmn.opqrstuv')).toBe(true);
    expect(isSecretLabel('user@example.com')).toBe(true);
    expect(isSecretLabel('AKIA1234567890ABCDEFGHIJ')).toBe(true);
    expect(isSecretLabel('Submit order')).toBe(false);
  });

  it('redacts secret labels and truncates long ones', () => {
    expect(redactLabel('api_key field', 20)).toEqual([REDACTED, true]);
    // natural spaced text (not token-shaped) is truncated, not redacted
    const [text, red] = redactLabel('long label with many short words here', 20);
    expect(red).toBe(false);
    expect(text.length).toBe(20);
  });

  it('strips query + fragment from the URL', () => {
    expect(redactUrl('https://x.com/orders?token=secret#a')).toBe('https://x.com/orders');
  });
});

describe('compactObservation (SPEC-147)', () => {
  it('drops values, redacts secrets, and returns a bounded observation', () => {
    const { result, report } = compactObservation(
      snap([
        { ref: 'e1', role: 'button', label: 'Submit', value: 'SHOULD-NOT-LEAK' },
        { ref: 'e2', role: 'textbox', label: 'Password', value: 'hunter2' },
      ]),
      caps,
    );
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toContain('SHOULD-NOT-LEAK');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('token=');
      expect(result.value.elements.find((e) => e.ref === 'e2')?.label).toBe(REDACTED);
      expect(result.value.urlRef).toBe('https://x.com/p');
    }
    expect(report?.redactedCount).toBe(1);
  });

  it('caps the element set by interactivity priority', () => {
    const { result, report } = compactObservation(
      snap([
        { ref: 'text', role: 'paragraph', label: 'lots of prose' },
        { ref: 'btn', role: 'button', label: 'Go' },
        { ref: 'link', role: 'link', label: 'Home' },
        { ref: 'input', role: 'textbox', label: 'Name' },
        { ref: 'text2', role: 'paragraph', label: 'more prose' },
      ]),
      caps,
    );
    expect(isSuccess(result)).toBe(true);
    if (isSuccess(result)) {
      // 3 kept, all interactive (paragraphs dropped first)
      expect(result.value.elements.map((e) => e.ref)).toEqual(['btn', 'link', 'input']);
    }
    expect(report?.keptCount).toBe(3);
    expect(report?.droppedCount).toBe(2);
  });

  it('fail-closed when the compacted view still exceeds the byte ceiling', () => {
    const big = 'x'.repeat(200);
    const { result } = compactObservation(
      snap([{ ref: 'e1', role: 'button', label: big }]),
      { maxElements: 1, maxLabelChars: 500, maxBytes: 50 },
    );
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(OBSERVATION_REASON_CODES.OVERSIZE);
  });

  it('fail-closed on a malformed snapshot / caps', () => {
    const { result } = compactObservation(snap([]), { ...caps, maxBytes: 0 });
    expect(isSuccess(result)).toBe(false);
    if (!isSuccess(result)) expect(result.reasonCodes).toContain(OBSERVATION_REASON_CODES.MALFORMED);
  });

  it('is deterministic (same input ⇒ identical output)', () => {
    const s = snap([{ ref: 'e1', role: 'button', label: 'Go' }]);
    const a = compactObservation(s, caps);
    const b = compactObservation(s, caps);
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });
});

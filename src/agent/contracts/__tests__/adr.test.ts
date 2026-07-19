import { describe, it, expect } from 'vitest';
import { ADR_STATUSES, lintAdrBody, parseAdrFilename } from '../adr';

const goodBody = `# ADR-0001: Freeze the AIOS request path

## Status
Accepted

## Context
why

## Decision
what

## Consequences
tradeoffs
`;

describe('parseAdrFilename', () => {
  it('accepts a well-formed ADR filename', () => {
    const r = parseAdrFilename('ADR-0001-freeze-the-request-path.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe(1);
      expect(r.slug).toBe('freeze-the-request-path');
    }
  });

  it('rejects a malformed filename', () => {
    const r = parseAdrFilename('adr1.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue.code).toBe('BAD_FILENAME');
  });
});

describe('lintAdrBody', () => {
  it('passes a complete ADR', () => {
    expect(lintAdrBody(goodBody)).toEqual([]);
  });

  it('flags a missing section', () => {
    const body = goodBody.replace('## Consequences\ntradeoffs\n', '');
    const issues = lintAdrBody(body);
    expect(issues.some((i) => i.code === 'MISSING_SECTION')).toBe(true);
  });

  it('flags a bad status value', () => {
    const body = goodBody.replace('Accepted', 'Maybe');
    const issues = lintAdrBody(body);
    expect(issues.some((i) => i.code === 'BAD_STATUS')).toBe(true);
  });

  it('flags a missing title heading', () => {
    const body = goodBody.replace('# ADR-0001: Freeze the AIOS request path', '# Something else');
    const issues = lintAdrBody(body);
    expect(issues.some((i) => i.code === 'MISSING_TITLE')).toBe(true);
  });

  it('exposes the four canonical statuses', () => {
    expect(ADR_STATUSES).toEqual(['Proposed', 'Accepted', 'Superseded', 'Rejected']);
  });
});

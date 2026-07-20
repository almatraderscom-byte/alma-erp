/**
 * Architecture Decision Record contract (G01 / SPEC-007).
 *
 * A typed model + validator for ADRs so the freeze process is machine-checkable.
 * The GLOBAL_AGENT_CONTRACT allows refining implementation details but forbids
 * reversing frozen boundaries "without a new architecture decision" — an ADR is
 * that decision, and this contract is how it is validated. Pure, no I/O.
 */

export const ADR_STATUSES = ['Proposed', 'Accepted', 'Superseded', 'Rejected'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

export const ADR_REQUIRED_SECTIONS = ['Status', 'Context', 'Decision', 'Consequences'] as const;

export interface AdrMeta {
  id: number; // e.g. 1 for ADR-0001
  slug: string; // kebab-case title
  status: AdrStatus;
}

export const ADR_FILENAME_RE = /^ADR-(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export interface AdrLintIssue {
  code: 'BAD_FILENAME' | 'MISSING_SECTION' | 'BAD_STATUS' | 'MISSING_TITLE';
  detail: string;
}

/** Validate an ADR's filename. Returns meta id/slug or an issue. */
export function parseAdrFilename(filename: string): { ok: true; id: number; slug: string } | { ok: false; issue: AdrLintIssue } {
  const m = ADR_FILENAME_RE.exec(filename);
  if (!m) {
    return { ok: false, issue: { code: 'BAD_FILENAME', detail: `expected ADR-NNNN-kebab-title.md, got ${filename}` } };
  }
  return { ok: true, id: Number(m[1]), slug: m[2] };
}

/** Lint an ADR document's body for required structure. */
export function lintAdrBody(body: string): AdrLintIssue[] {
  const issues: AdrLintIssue[] = [];
  if (!/^#\s+ADR-\d{4}:/m.test(body)) {
    issues.push({ code: 'MISSING_TITLE', detail: 'first heading must be "# ADR-NNNN: <title>"' });
  }
  for (const section of ADR_REQUIRED_SECTIONS) {
    if (!new RegExp(`^##\\s+${section}\\b`, 'm').test(body)) {
      issues.push({ code: 'MISSING_SECTION', detail: `missing "## ${section}" section` });
    }
  }
  const statusMatch = /^##\s+Status\s*\n+([^\n]+)/m.exec(body);
  if (statusMatch) {
    const declared = statusMatch[1].trim();
    if (!ADR_STATUSES.some((s) => declared.startsWith(s))) {
      issues.push({ code: 'BAD_STATUS', detail: `status "${declared}" is not one of ${ADR_STATUSES.join(', ')}` });
    }
  }
  return issues;
}

/**
 * Repository ownership zones and CODEOWNERS model (G01 / SPEC-003).
 *
 * Deterministic registry mapping path prefixes to an owning group/team. Used to
 * (a) generate a CODEOWNERS proposal and (b) enforce that a group session only
 * edits its own zones — the RUNNER "no concurrent edits to the same ownership
 * zone" rule. Pure: no I/O, no LLM.
 */

export interface OwnershipZone {
  /** repo-relative path prefix that defines the zone */
  prefix: string;
  /** owning AIOS group (or 'shared' / 'erp') */
  owner: string;
  /** CODEOWNERS team handle */
  team: string;
  /** if true, only the integration session may edit (shared choke point) */
  integrationOnly?: boolean;
}

/**
 * Ordered most-specific-first. `resolveOwner` returns the first prefix match.
 */
export const OWNERSHIP_ZONES: OwnershipZone[] = [
  // G01 owned zones (this group).
  { prefix: 'docs/architecture', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'scripts/architecture', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'src/agent/contracts', owner: 'G01', team: '@alma/architecture' },
  { prefix: 'artifacts', owner: 'G01', team: '@alma/architecture' },
  // Shared choke points — integration session only.
  { prefix: 'prisma/schema.prisma', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: 'package-lock.json', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: 'package.json', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  { prefix: '.github', owner: 'integration', team: '@alma/architecture', integrationOnly: true },
  // Agent runtime (later groups refine sub-zones).
  { prefix: 'src/app/api/assistant', owner: 'agent', team: '@alma/agent' },
  { prefix: 'src/app/agent', owner: 'agent', team: '@alma/agent' },
  { prefix: 'src/agent', owner: 'agent', team: '@alma/agent' },
  // Legacy agent API — frozen (CLAUDE.md: never touch).
  { prefix: 'src/app/api/agent', owner: 'frozen-legacy', team: '@alma/agent', integrationOnly: true },
  // ERP production.
  { prefix: 'src/app', owner: 'erp', team: '@alma/erp' },
  { prefix: 'src/lib', owner: 'erp', team: '@alma/erp' },
];

export const OWNERSHIP_REASON_CODES = {
  OWNERSHIP_CONFLICT: 'OWNERSHIP_CONFLICT',
  UNOWNED_PATH: 'UNOWNED_PATH',
  INTEGRATION_ONLY: 'INTEGRATION_ONLY',
} as const;

export function resolveOwner(path: string): OwnershipZone | null {
  const p = path.replace(/^\.\//, '');
  for (const z of OWNERSHIP_ZONES) {
    const isFilePrefix = z.prefix.includes('.'); // e.g. package.json, schema.prisma
    if (isFilePrefix) {
      if (p === z.prefix || p.startsWith(z.prefix)) return z;
    } else if (p === z.prefix || p.startsWith(z.prefix + '/')) {
      return z;
    }
  }
  return null;
}

export interface OwnershipViolation {
  file: string;
  reasonCode: string;
  detail: string;
}

/**
 * Given a set of changed files and the session's owner id, return any file that
 * belongs to a different owner or is integration-only. Fail-closed: unowned
 * paths are reported (UNOWNED_PATH) rather than silently allowed.
 */
export function checkChangeSet(files: string[], sessionOwner: string): OwnershipViolation[] {
  const out: OwnershipViolation[] = [];
  for (const file of files) {
    const zone = resolveOwner(file);
    if (!zone) {
      out.push({ file, reasonCode: OWNERSHIP_REASON_CODES.UNOWNED_PATH, detail: 'no ownership zone matches this path' });
      continue;
    }
    if (zone.integrationOnly && sessionOwner !== 'integration') {
      out.push({
        file,
        reasonCode: OWNERSHIP_REASON_CODES.INTEGRATION_ONLY,
        detail: `${zone.prefix} is a shared choke point (owner=${zone.owner}); only the integration session may edit it`,
      });
      continue;
    }
    if (zone.owner !== sessionOwner && !zone.integrationOnly) {
      out.push({
        file,
        reasonCode: OWNERSHIP_REASON_CODES.OWNERSHIP_CONFLICT,
        detail: `owned by ${zone.owner}, but session owner is ${sessionOwner}`,
      });
    }
  }
  return out;
}

/** Render a CODEOWNERS file body from the zone registry. */
export function renderCodeowners(): string {
  const lines = [
    '# GENERATED from src/agent/contracts/ownership.ts (G01 / SPEC-003).',
    '# Proposal only — the real .github/CODEOWNERS is a shared choke point',
    '# edited by the integration session, never by a group session.',
    '',
  ];
  for (const z of OWNERSHIP_ZONES) {
    const glob = z.prefix.includes('.') ? `/${z.prefix}` : `/${z.prefix}/`;
    lines.push(`${glob} ${z.team}`);
  }
  return lines.join('\n') + '\n';
}

import { describe, it, expect } from 'vitest';
import {
  OWNERSHIP_REASON_CODES,
  OWNERSHIP_ZONES,
  checkChangeSet,
  renderCodeowners,
  resolveOwner,
} from '../ownership';

describe('resolveOwner', () => {
  it('maps G01 owned zones', () => {
    expect(resolveOwner('docs/architecture/invariants.md')?.owner).toBe('G01');
    expect(resolveOwner('scripts/architecture/inventory.mjs')?.owner).toBe('G01');
    expect(resolveOwner('src/agent/contracts/component.ts')?.owner).toBe('G01');
  });

  it('maps agent + erp + frozen zones', () => {
    expect(resolveOwner('src/app/api/assistant/x/route.ts')?.owner).toBe('agent');
    expect(resolveOwner('src/agent/lib/x.ts')?.owner).toBe('agent');
    expect(resolveOwner('src/app/orders/page.tsx')?.owner).toBe('erp');
    expect(resolveOwner('src/lib/money.ts')?.owner).toBe('erp');
    expect(resolveOwner('src/app/api/agent/route.ts')?.owner).toBe('frozen-legacy');
  });

  it('marks shared choke points integration-only', () => {
    expect(resolveOwner('prisma/schema.prisma')?.integrationOnly).toBe(true);
    expect(resolveOwner('package.json')?.integrationOnly).toBe(true);
    expect(resolveOwner('.github/workflows/ci.yml')?.integrationOnly).toBe(true);
  });

  it('does not match across path boundaries', () => {
    // 'src/agent/contracts' prefix must not swallow 'src/agent/contracts-x'
    expect(resolveOwner('src/agent/contractsX/y.ts')?.owner).toBe('agent');
  });
});

describe('checkChangeSet — group isolation', () => {
  it('allows a G01 session editing only G01 zones', () => {
    const files = [
      'src/agent/contracts/component.ts',
      'scripts/architecture/inventory.mjs',
      'docs/architecture/x.md',
      'artifacts/SPEC-003/final-verdict.md',
    ];
    expect(checkChangeSet(files, 'G01')).toEqual([]);
  });

  it('flags a G01 session touching ERP code as a conflict', () => {
    const v = checkChangeSet(['src/lib/money.ts'], 'G01');
    expect(v).toHaveLength(1);
    expect(v[0].reasonCode).toBe(OWNERSHIP_REASON_CODES.OWNERSHIP_CONFLICT);
  });

  it('flags a group session touching a shared choke point', () => {
    const v = checkChangeSet(['prisma/schema.prisma'], 'G01');
    expect(v[0].reasonCode).toBe(OWNERSHIP_REASON_CODES.INTEGRATION_ONLY);
  });

  it('allows the integration session to touch choke points', () => {
    expect(checkChangeSet(['package.json', 'prisma/schema.prisma'], 'integration')).toEqual([]);
  });

  it('fails closed on an unowned path', () => {
    const v = checkChangeSet(['random/unmapped/file.ts'], 'G01');
    expect(v[0].reasonCode).toBe(OWNERSHIP_REASON_CODES.UNOWNED_PATH);
  });
});

describe('renderCodeowners', () => {
  it('emits a CODEOWNERS line per zone with a team handle', () => {
    const body = renderCodeowners();
    expect(body).toContain('/docs/architecture/ @alma/architecture');
    expect(body).toContain('/src/agent/ @alma/agent');
    expect(body).toContain('/src/lib/ @alma/erp');
    // one owner line per zone + header
    const ownerLines = body.split('\n').filter((l) => l.startsWith('/'));
    expect(ownerLines.length).toBe(OWNERSHIP_ZONES.length);
  });
});

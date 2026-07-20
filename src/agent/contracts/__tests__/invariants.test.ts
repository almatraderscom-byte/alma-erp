import { describe, it, expect } from 'vitest';
import {
  ARCHITECTURE_INVARIANTS,
  FORBIDDEN_IMPORT_RULES,
  INVARIANT_REASON_CODES,
  checkImport,
  importTargetZone,
  zoneOf,
} from '../invariants';

describe('invariants registry', () => {
  it('freezes exactly ten invariants with stable ids', () => {
    expect(ARCHITECTURE_INVARIANTS).toHaveLength(10);
    expect(ARCHITECTURE_INVARIANTS.map((i) => i.id)).toEqual([
      'INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05',
      'INV-06', 'INV-07', 'INV-08', 'INV-09', 'INV-10',
    ]);
  });
});

describe('zoneOf', () => {
  it('classifies paths into zones', () => {
    expect(zoneOf('src/app/api/orders/route.ts')).toBe('erp-api');
    expect(zoneOf('src/app/orders/page.tsx')).toBe('erp-app');
    expect(zoneOf('src/lib/money.ts')).toBe('shared-lib');
    expect(zoneOf('src/agent/lib/models/registry.ts')).toBe('agent');
    expect(zoneOf('src/agent/contracts/component.ts')).toBe('agent-contracts');
    expect(zoneOf('src/app/api/agent/route.ts')).toBe('legacy-agent-api');
  });

  it('treats agent UI + assistant API as agent-side (not ERP)', () => {
    // Per CLAUDE.md the agent lives in src/agent, src/app/agent and
    // src/app/api/assistant — these may import the agent module.
    expect(zoneOf('src/app/agent/costs/page.tsx')).toBe('agent-app');
    expect(zoneOf('src/app/api/assistant/chat/route.ts')).toBe('assistant-api');
  });
});

describe('agent-side zones are allowed to import the agent', () => {
  it('agent UI page importing @/agent/* is NOT a violation', () => {
    expect(checkImport('src/app/agent/costs/page.tsx', 'agent-app', '@/agent/config')).toBeNull();
  });
  it('assistant API importing @/agent/* is NOT a violation', () => {
    expect(checkImport('src/app/api/assistant/chat/route.ts', 'assistant-api', '@/agent/lib/x')).toBeNull();
  });
});

describe('importTargetZone', () => {
  it('resolves agent + lib specifiers, ignores external', () => {
    expect(importTargetZone('@/agent/lib/x')).toBe('agent');
    expect(importTargetZone('@/agent/contracts/component')).toBe('agent-contracts');
    expect(importTargetZone('@/lib/money')).toBe('shared-lib');
    expect(importTargetZone('react')).toBeNull();
    expect(importTargetZone('zod')).toBeNull();
  });
});

describe('checkImport — forbidden dependency rule', () => {
  it('flags ERP app importing the agent', () => {
    const v = checkImport('src/app/orders/page.tsx', 'erp-app', '@/agent/lib/x');
    expect(v).not.toBeNull();
    expect(v?.reasonCode).toBe(INVARIANT_REASON_CODES.FORBIDDEN_IMPORT);
    expect(v?.toZone).toBe('agent');
  });

  it('flags ERP api importing agent contracts', () => {
    const v = checkImport('src/app/api/x/route.ts', 'erp-api', '@/agent/contracts/component');
    expect(v?.reasonCode).toBe(INVARIANT_REASON_CODES.FORBIDDEN_IMPORT);
  });

  it('flags shared-lib importing the agent', () => {
    const v = checkImport('src/lib/util.ts', 'shared-lib', 'src/agent/lib/x');
    expect(v).not.toBeNull();
  });

  it('allows ERP importing shared libs', () => {
    expect(checkImport('src/app/orders/page.tsx', 'erp-app', '@/lib/money')).toBeNull();
  });

  it('allows the agent importing shared libs (one-way is fine)', () => {
    expect(checkImport('src/agent/lib/x.ts', 'agent', '@/lib/money')).toBeNull();
  });

  it('ignores external package imports', () => {
    expect(checkImport('src/app/x.tsx', 'erp-app', 'react')).toBeNull();
  });

  it('has a rule for every ERP-facing zone', () => {
    const froms = FORBIDDEN_IMPORT_RULES.map((r) => r.from);
    expect(froms).toContain('erp-app');
    expect(froms).toContain('erp-api');
    expect(froms).toContain('shared-lib');
  });
});

import { describe, it, expect } from 'vitest';
import {
  scanFileForBypass, isInsidePolicyPackage, resolveToRepoPath, importsPolicyLayer, isAuthorizationAware,
} from '../bypass-gate';

describe('resolveToRepoPath / importsPolicyLayer (SPEC-110)', () => {
  it('resolves aliases and relatives', () => {
    expect(resolveToRepoPath('src/agent/tools/x.ts', '@/agent/policy/rbac')).toBe('src/agent/policy/rbac');
    expect(resolveToRepoPath('src/agent/tools/x.ts', '../policy/abac')).toBe('src/agent/policy/abac');
  });
  it('detects a layer deep-import', () => {
    expect(importsPolicyLayer('src/agent/tools/x.ts', '@/agent/policy/rbac')).toBe('rbac');
    expect(importsPolicyLayer('src/agent/tools/x.ts', '@/agent/policy/decision')).toBeNull();
    expect(importsPolicyLayer('src/agent/tools/x.ts', '@/agent/policy')).toBeNull(); // barrel is fine
  });
});

describe('isInsidePolicyPackage', () => {
  it('exempts the engine itself', () => {
    expect(isInsidePolicyPackage('src/agent/policy/rbac.ts')).toBe(true);
    expect(isInsidePolicyPackage('src/agent/tools/gateway.ts')).toBe(false);
  });
});

describe('scanFileForBypass (SPEC-110)', () => {
  it('flags a layer deep-import that calls .evaluate()', () => {
    const src = `import { rbacLayer } from '@/agent/policy/rbac';\nconst v = rbacLayer([]).evaluate(input);`;
    const v = scanFileForBypass('src/agent/tools/x.ts', src, ['@/agent/policy/rbac']);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('layer-evaluate');
  });

  it('does NOT flag engine assembly via the barrel + decide()', () => {
    const src = `import { PolicyEngine, rbacLayer } from '@/agent/policy';\nconst r = new PolicyEngine([rbacLayer([])]).decide(input);`;
    expect(scanFileForBypass('src/agent/wiring/x.ts', src, ['@/agent/policy'])).toHaveLength(0);
  });

  it('flags a raw privileged-role comparison IN an authz-aware file', () => {
    const src = `import { humanPrincipal } from '@/agent/identity/principals';\nfunction can(p) {\n  if (p.role === 'owner') return true;\n  return false;\n}`;
    const v = scanFileForBypass('src/agent/tools/y.ts', src, ['@/agent/identity/principals']);
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('hand-rolled-authz');
    expect(v[0].line).toBe(3);
  });

  it('flags .roles.includes on a privileged literal (authz-aware file)', () => {
    const src = `const ok = principal.roles.includes('admin');`;
    const v = scanFileForBypass('src/agent/tools/z.ts', src, ['@/agent/policy']);
    expect(v.some((x) => x.kind === 'hand-rolled-authz')).toBe(true);
  });

  it('does NOT flag a raw \'owner\' literal in a NON-authz file (data value, not a role)', () => {
    // e.g. existing agent tools: task/author source === 'owner' is DATA, not authz.
    const src = `if (task.source === 'owner') return 'Boss';`;
    expect(scanFileForBypass('src/agent/lib/todo-sort.ts', src, [])).toHaveLength(0);
  });

  it('isAuthorizationAware detects policy/identity imports', () => {
    expect(isAuthorizationAware('src/agent/tools/y.ts', ['@/agent/identity/principals'])).toBe(true);
    expect(isAuthorizationAware('src/agent/tools/y.ts', ['@/agent/policy'])).toBe(true);
    expect(isAuthorizationAware('src/agent/tools/y.ts', ['@/lib/money'])).toBe(false);
  });

  it('honours the reviewed opt-out marker', () => {
    const src = `import '@/agent/policy';\nif (p.role === 'owner') grant(); // policy-bypass-ok: bootstrap seed`;
    expect(scanFileForBypass('src/agent/tools/seed.ts', src, ['@/agent/policy'])).toHaveLength(0);
  });

  it('is clean for ordinary code', () => {
    const src = `import { decidePolicy } from '@/agent/policy';\nconst r = decidePolicy(input, layers);\nif (r.status === 'ALLOWED') doThing();`;
    expect(scanFileForBypass('src/agent/tools/ok.ts', src, ['@/agent/policy'])).toHaveLength(0);
  });

  it('never flags files inside the policy package', () => {
    const src = `const v = someLayer.evaluate(input);\nif (role === 'owner') {}`;
    expect(scanFileForBypass('src/agent/policy/decision.ts', src, ['@/agent/policy/rbac'])).toHaveLength(0);
  });
});

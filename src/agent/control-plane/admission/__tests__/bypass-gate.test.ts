import { describe, it, expect } from 'vitest';
import {
  ADMISSION_INTERNAL_MODULES,
  ADMISSION_PUBLIC_ENTRYPOINTS,
  isAdmissionBypass,
} from '../bypass-gate';

describe('isAdmissionBypass', () => {
  it('flags an outsider importing an internal stage module', () => {
    const v = isAdmissionBypass('src/app/api/assistant/x/route.ts', '@/agent/control-plane/admission/normalize');
    expect(v).not.toBeNull();
    expect(v?.module).toBe('normalize');
  });

  it('flags outsiders importing the registry or any internal stage', () => {
    for (const mod of ADMISSION_INTERNAL_MODULES) {
      const v = isAdmissionBypass('src/agent/foo.ts', `@/agent/control-plane/admission/${mod}`);
      expect(v?.module).toBe(mod);
    }
  });

  it('allows outsiders to use the public entrypoints', () => {
    for (const pub of ADMISSION_PUBLIC_ENTRYPOINTS) {
      expect(isAdmissionBypass('src/app/api/assistant/x/route.ts', `@/agent/control-plane/admission/${pub}`)).toBeNull();
    }
  });

  it('allows admission-internal files to import each other', () => {
    expect(isAdmissionBypass('src/agent/control-plane/admission/registry.ts', './normalize')).toBeNull();
    expect(isAdmissionBypass('src/agent/control-plane/admission/gateway.ts', '@/agent/control-plane/admission/normalize')).toBeNull();
  });

  it('ignores unrelated imports', () => {
    expect(isAdmissionBypass('src/app/x.ts', 'react')).toBeNull();
    expect(isAdmissionBypass('src/app/x.ts', '@/lib/money')).toBeNull();
  });

  // Vercel review: relative-path imports of internal stages were previously
  // missed, letting agent code outside the package bypass the gateway.
  it('flags a relative-path import of an internal stage (sibling in control-plane)', () => {
    const v = isAdmissionBypass('src/agent/control-plane/foo.ts', './admission/normalize');
    expect(v).not.toBeNull();
    expect(v?.module).toBe('normalize');
  });

  it('flags a deeper relative-path import (../.. traversal)', () => {
    const v = isAdmissionBypass('src/agent/lib/x.ts', '../control-plane/admission/dedup');
    expect(v?.module).toBe('dedup');
  });

  it('does NOT flag a relative import that stays inside the package', () => {
    // e.g. an admission-internal file — already covered — but also a relative
    // path that resolves outside the admission internals is fine.
    expect(isAdmissionBypass('src/agent/control-plane/foo.ts', './admission/gateway')).toBeNull();
  });
});

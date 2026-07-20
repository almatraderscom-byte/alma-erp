import { describe, it, expect } from 'vitest';
import { buildReplayRecord, hashContext, verifyReplay } from '../provenance';
import { compile } from '../compiler';
import { constitutionBundle, memoryBundle, requestSuffixBundle } from '../../prompts/bundles';

const bundles = () => [constitutionBundle('rules'), memoryBundle(['m1']), requestSuffixBundle('do it')];

describe('provenance & replay (SPEC-050)', () => {
  it('records bundle provenance + a content hash', () => {
    const rec = buildReplayRecord(compile(bundles()));
    expect(rec.bundles.map((b) => b.kind)).toEqual(['constitution', 'memory', 'request_suffix']);
    expect(rec.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyReplay passes for a faithful recompile (deterministic)', () => {
    const rec = buildReplayRecord(compile(bundles()));
    expect(verifyReplay(rec, compile(bundles()))).toBe(true);
  });

  it('verifyReplay FAILS when content changes', () => {
    const rec = buildReplayRecord(compile(bundles()));
    const tampered = compile([constitutionBundle('DIFFERENT'), memoryBundle(['m1']), requestSuffixBundle('do it')]);
    expect(verifyReplay(rec, tampered)).toBe(false);
  });

  it('verifyReplay FAILS when a bundle version changes', () => {
    const rec = buildReplayRecord(compile(bundles()));
    const bumped = compile([constitutionBundle('rules', '9'), memoryBundle(['m1']), requestSuffixBundle('do it')]);
    expect(verifyReplay(rec, bumped)).toBe(false);
  });

  it('hashContext is stable', () => {
    expect(hashContext('abc')).toBe(hashContext('abc'));
    expect(hashContext('abc')).not.toBe(hashContext('abd'));
  });
});

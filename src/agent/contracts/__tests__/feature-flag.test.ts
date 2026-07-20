import { describe, it, expect } from 'vitest';
import {
  FEATURE_MODES,
  canTransition,
  decide,
  featureFlagSchema,
  getMode,
  rollbackTarget,
} from '../feature-flag';

describe('feature modes', () => {
  it('freezes the five canonical modes', () => {
    expect(FEATURE_MODES).toEqual(['off', 'shadow', 'warn', 'enforce', 'rollback']);
  });

  it('off = legacy only', () => {
    const d = decide('off');
    expect(d.legacyAuthoritative).toBe(true);
    expect(d.runNewPath).toBe(false);
    expect(d.newAuthoritative).toBe(false);
  });

  it('shadow = legacy authoritative, new compared', () => {
    const d = decide('shadow');
    expect(d.legacyAuthoritative).toBe(true);
    expect(d.compareShadow).toBe(true);
    expect(d.newAuthoritative).toBe(false);
  });

  it('warn = legacy authoritative, violations reported', () => {
    const d = decide('warn');
    expect(d.reportViolations).toBe(true);
    expect(d.newAuthoritative).toBe(false);
  });

  it('enforce = new path authoritative', () => {
    const d = decide('enforce');
    expect(d.newAuthoritative).toBe(true);
    expect(d.legacyAuthoritative).toBe(false);
  });

  it('rollback = legacy authoritative, new path off', () => {
    const d = decide('rollback');
    expect(d.isRollback).toBe(true);
    expect(d.legacyAuthoritative).toBe(true);
    expect(d.runNewPath).toBe(false);
  });
});

describe('transitions', () => {
  it('follows the migration ladder', () => {
    expect(canTransition('off', 'shadow')).toBe(true);
    expect(canTransition('shadow', 'warn')).toBe(true);
    expect(canTransition('warn', 'enforce')).toBe(true);
    expect(canTransition('off', 'enforce')).toBe(false); // cannot skip
  });

  it('allows rollback from any mode', () => {
    for (const m of FEATURE_MODES) expect(canTransition(m, 'rollback')).toBe(true);
  });
});

describe('rollbackTarget', () => {
  it('defaults to off when no last-known-good', () => {
    expect(rollbackTarget({ name: 'x', mode: 'enforce' })).toBe('off');
  });

  it('uses last-known-good but never enforce', () => {
    expect(rollbackTarget({ name: 'x', mode: 'enforce', lastKnownGoodMode: 'warn' })).toBe('warn');
    expect(rollbackTarget({ name: 'x', mode: 'enforce', lastKnownGoodMode: 'enforce' })).toBe('off');
  });
});

describe('getMode + schema', () => {
  it('defaults unknown flags to off (fail-safe)', () => {
    expect(getMode({}, 'missing')).toBe('off');
    expect(getMode({ a: 'enforce' }, 'a')).toBe('enforce');
  });

  it('validates a flag record', () => {
    expect(featureFlagSchema.safeParse({ name: 'a', mode: 'shadow' }).success).toBe(true);
    expect(featureFlagSchema.safeParse({ name: 'a', mode: 'nope' }).success).toBe(false);
  });
});

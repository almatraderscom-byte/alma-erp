import { describe, it, expect } from 'vitest';
import { conversationCacheKey, requestHash, tenantOfKey } from '../conversation-key';

const id = (t: string) => ({ tenantId: t, actorId: 'm', workflowId: 'w', stepId: 's', correlationId: 'c' });

describe('conversation cache-key (SPEC-064)', () => {
  it('same tenant+prefix+request -> same key', () => {
    expect(conversationCacheKey(id('alma'), 'pfx_1', 'hi')).toBe(conversationCacheKey(id('alma'), 'pfx_1', 'hi'));
  });
  it('different tenant -> different key (isolation baked in)', () => {
    expect(conversationCacheKey(id('alma'), 'pfx_1', 'hi')).not.toBe(conversationCacheKey(id('rival'), 'pfx_1', 'hi'));
  });
  it('different request -> different key', () => {
    expect(conversationCacheKey(id('alma'), 'pfx_1', 'a')).not.toBe(conversationCacheKey(id('alma'), 'pfx_1', 'b'));
  });
  it('different prefix -> different key', () => {
    expect(conversationCacheKey(id('alma'), 'pfx_1', 'x')).not.toBe(conversationCacheKey(id('alma'), 'pfx_2', 'x'));
  });
  it('tenantOfKey recovers the tenant', () => {
    expect(tenantOfKey(conversationCacheKey(id('alma'), 'pfx_1', 'x'))).toBe('alma');
    expect(tenantOfKey('garbage')).toBeNull();
  });
  it('requestHash is stable', () => {
    expect(requestHash('abc')).toBe(requestHash('abc'));
  });
});

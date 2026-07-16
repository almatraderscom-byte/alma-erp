import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import {
  classifyPublishFailure,
  runSocialPublish,
  socialPayloadHash,
  type SocialPayload,
} from '@/agent/lib/marketing/social-ops-graph'

const payload = (over: Partial<SocialPayload> = {}): SocialPayload => ({
  platform: 'instagram',
  pageRef: 'lifestyle',
  caption: 'ঈদের নতুন কালেকশন',
  imageRef: 'generated/eid-set.png',
  ...over,
})

describe('socialPayloadHash — one approval = one immutable payload', () => {
  it('same payload → same hash; ANY drift (caption/asset/destination) → different hash', () => {
    const h = socialPayloadHash(payload())
    expect(socialPayloadHash(payload())).toBe(h)
    expect(socialPayloadHash(payload({ caption: 'অন্য ক্যাপশন' }))).not.toBe(h)
    expect(socialPayloadHash(payload({ imageRef: 'generated/other.png' }))).not.toBe(h)
    expect(socialPayloadHash(payload({ pageRef: 'onlineshop' }))).not.toBe(h)
    expect(socialPayloadHash(payload({ platform: 'facebook' }))).not.toBe(h)
  })
})

describe('classifyPublishFailure — recovery playbooks', () => {
  it('expired token → owner action, not retryable', () => {
    const p = classifyPublishFailure('Error validating access token: Session has expired')
    expect(p.kind).toBe('token_expired')
    expect(p.retryable).toBe(false)
    expect(p.recovery).toContain('token')
  })

  it('permission loss / rate limit / media processing / rejection each map correctly', () => {
    expect(classifyPublishFailure('(#200) The user has not authorized application').kind).toBe('permission_lost')
    const rl = classifyPublishFailure('(#4) Application request limit reached — too many calls')
    expect(rl.kind).toBe('rate_limit')
    expect(rl.retryable).toBe(true)
    const mp = classifyPublishFailure('IG container 400: Media upload failed, image fetch error')
    expect(mp.kind).toBe('media_processing')
    expect(mp.retryable).toBe(true)
    expect(classifyPublishFailure('Post rejected for policy violation').kind).toBe('post_rejected')
  })

  it('unknown errors stay honest — no blind retry', () => {
    const p = classifyPublishFailure('something weird happened')
    expect(p.kind).toBe('unknown')
    expect(p.retryable).toBe(false)
  })
})

describe('runSocialPublish — delivery truth', () => {
  const approved = socialPayloadHash(payload())

  it('payload drift aborts BEFORE any publish call', async () => {
    const publish = vi.fn()
    const verify = vi.fn()
    const r = await runSocialPublish(payload({ caption: 'বদলানো ক্যাপশন' }), approved, { publish, verify })
    expect(r.status).toBe('failed')
    expect(r.playbook?.kind).toBe('payload_drift')
    expect(publish).not.toHaveBeenCalled()
  })

  it('publish ok + fetch-back verify ok → delivered_verified with permalink', async () => {
    const r = await runSocialPublish(payload(), approved, {
      publish: async () => ({ ok: true, postId: 'm1' }),
      verify: async () => ({ ok: true, permalink: 'https://instagram.com/p/x' }),
    })
    expect(r.status).toBe('delivered_verified')
    expect(r.permalink).toContain('instagram.com')
  })

  it('publish ok but verify fails → published_unverified, NEVER claimed delivered', async () => {
    const r = await runSocialPublish(payload(), approved, {
      publish: async () => ({ ok: true, postId: 'm2' }),
      verify: async () => ({ ok: false, error: 'IG verify 400: media not found' }),
    })
    expect(r.status).toBe('published_unverified')
    expect(r.postId).toBe('m2')
  })

  it('publish failure carries its playbook', async () => {
    const r = await runSocialPublish(payload(), approved, {
      publish: async () => ({ ok: false, error: '(#4) too many calls' }),
      verify: async () => ({ ok: true }),
    })
    expect(r.status).toBe('failed')
    expect(r.playbook?.kind).toBe('rate_limit')
  })
})

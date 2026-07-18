import { describe, it, expect, afterEach } from 'vitest'
import {
  META_GRAPH_DEFAULT_VERSION,
  metaGraphVersion,
  metaGraphBase,
} from '@/lib/meta-version'
// The worker cannot import TS; this parity test is the ONLY guard against the
// two defaults drifting apart (roadmap Phase 63 GAP-11).
import {
  META_GRAPH_DEFAULT_VERSION as WORKER_DEFAULT,
  metaGraphBase as workerBase,
} from '../../../worker/src/meta-version.mjs'

const ORIGINAL = process.env.META_GRAPH_VERSION

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.META_GRAPH_VERSION
  else process.env.META_GRAPH_VERSION = ORIGINAL
})

describe('shared Meta Graph version resolver (Phase 63 centralization)', () => {
  it('preserves the tested default — the migration must not change live URLs', () => {
    delete process.env.META_GRAPH_VERSION
    expect(META_GRAPH_DEFAULT_VERSION).toBe('v21.0')
    expect(metaGraphBase()).toBe('https://graph.facebook.com/v21.0')
  })

  it('honours a valid env override and ignores an invalid one', () => {
    process.env.META_GRAPH_VERSION = 'v23.0'
    expect(metaGraphVersion()).toBe('v23.0')
    expect(metaGraphBase()).toBe('https://graph.facebook.com/v23.0')
    process.env.META_GRAPH_VERSION = 'nonsense'
    expect(metaGraphVersion()).toBe('v21.0')
  })

  it('the worker mirror matches the TS default exactly (no drift)', () => {
    delete process.env.META_GRAPH_VERSION
    expect(WORKER_DEFAULT).toBe(META_GRAPH_DEFAULT_VERSION)
    expect(workerBase()).toBe(metaGraphBase())
  })
})

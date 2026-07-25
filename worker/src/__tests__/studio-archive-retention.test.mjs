import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  archiveReceiptDeletionEligibility,
  collectBigPaths,
} from '../schedulers/studio-archive.mjs'
import {
  runCreativeDistributionTick,
} from '../schedulers/creative-performance.mjs'

test('archive cleanup requires a durable verified receipt and both time windows', () => {
  const now = new Date('2026-08-31T00:00:00.000Z')
  const base = {
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    now,
    retentionDays: 30,
    verificationGraceHours: 24,
    deleteOriginalsEnabled: true,
  }

  assert.deepEqual(
    archiveReceiptDeletionEligibility({ ...base, verifiedAt: null }),
    { eligible: false, reason: 'durable_verification_required' },
  )
  assert.deepEqual(
    archiveReceiptDeletionEligibility({
      ...base,
      verifiedAt: new Date('2026-08-30T12:00:00.000Z'),
    }),
    { eligible: false, reason: 'verification_grace_active' },
  )
  assert.deepEqual(
    archiveReceiptDeletionEligibility({
      ...base,
      verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
    }),
    { eligible: true, reason: 'verified_archive_retention_elapsed' },
  )
})

test('archive path collection excludes thumbnails and deduplicates originals', () => {
  assert.deepEqual(
    collectBigPaths({
      storagePath: 'generated/hero.png',
      brandedPath: 'generated/hero.png',
      videoPath: 'generated/reel.mp4',
      thumbPath: 'generated/hero-thumb.webp',
      allPaths: ['generated/hero.png', 'generated/story.png'],
    }),
    [
      'generated/hero.png',
      'generated/reel.mp4',
      'generated/story.png',
    ],
  )
})

test('distribution tick wakes publish before performance with bounded intents', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), token: init.headers['x-agent-internal-token'] })
    return new Response(JSON.stringify(
      url.endsWith('/publish')
        ? { processed: 1, published: 1 }
        : { processed: 1, inserted: 1 },
    ), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const result = await runCreativeDistributionTick({
    appUrl: 'https://preview.example/',
    internalToken: 'internal-test-token',
    fetchImpl,
  })

  assert.equal(result.status, 'done')
  assert.deepEqual(calls.map((call) => call.body), [
    { intent: 'process_due', limit: 5 },
    { intent: 'sync_due', limit: 10 },
  ])
  assert.ok(calls[0].url.endsWith('/api/assistant/creative-studio/publish'))
  assert.ok(calls[1].url.endsWith('/api/assistant/creative-studio/performance'))
  assert.equal(calls[0].token, 'internal-test-token')
})

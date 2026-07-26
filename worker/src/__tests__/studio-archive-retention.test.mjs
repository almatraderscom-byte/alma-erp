import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  archiveVerificationAttemptEvidence,
  archiveVerificationRetryDecision,
  archiveReceiptDeletionEligibility,
  collectBigPaths,
  exactArchiveFetchBackEvidence,
  lifecycleArchiveLineage,
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
  assert.deepEqual(
    archiveReceiptDeletionEligibility({
      ...base,
      verifiedAt: new Date('2026-08-29T00:00:00.000Z'),
      compositionId: 'composition-1',
    }),
    { eligible: false, reason: 'lifecycle_archive_no_delete' },
  )
})

test('lifecycle archive lineage pins composition, operation package, proxy, original and render', () => {
  const lineage = lifecycleArchiveLineage({
    payload: {},
  }, {
    lifecycleAttribution: {
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-2',
      compositionVersion: 2,
      compositionDocumentHash: 'a'.repeat(64),
      operationBatchId: 'batch-2',
      operationPackageChecksum: 'b'.repeat(64),
      originalStoragePath: 'generated/original.mp4',
      renderStoragePath: 'generated/render.mp4',
      playableProxyPath: 'generated/proxy.mp4',
    },
  }, 'generated/render.mp4')
  assert.deepEqual(lineage, {
    compositionId: 'composition-1',
    compositionVersionId: 'composition-version-2',
    compositionVersion: 2,
    compositionDocumentHash: 'a'.repeat(64),
    operationBatchId: 'batch-2',
    operationPackageChecksum: 'b'.repeat(64),
    playableProxyPath: 'generated/proxy.mp4',
    originalStoragePath: 'generated/original.mp4',
    renderStoragePath: 'generated/render.mp4',
    lineageManifest: {
      original: 'generated/original.mp4',
      render: 'generated/render.mp4',
      playableProxy: 'generated/proxy.mp4',
    },
  })
  assert.throws(() => lifecycleArchiveLineage({ payload: {} }, {
    lifecycleAttribution: {
      compositionId: 'composition-1',
      compositionVersionId: 'composition-version-2',
      compositionVersion: 2,
    },
  }, 'generated/render.mp4'), /lifecycle archive attribution incomplete/)
})

test('archive verification preserves failed fetch-back evidence instead of claiming success', () => {
  const expectedChecksum = 'a'.repeat(64)
  assert.deepEqual(archiveVerificationAttemptEvidence({
    archiveReceiptId: 'receipt-1',
    expectedChecksum,
    archiveChecksum: expectedChecksum,
    fetchBackChecksum: 'b'.repeat(64),
  }), {
    archiveReceiptId: 'receipt-1',
    outcome: 'failed',
    expectedChecksum,
    archiveChecksum: expectedChecksum,
    fetchBackChecksum: 'b'.repeat(64),
    errorCode: 'drive_fetch_back_checksum_mismatch',
  })
  assert.equal(archiveVerificationAttemptEvidence({
    archiveReceiptId: 'receipt-1',
    expectedChecksum,
    archiveChecksum: expectedChecksum,
    fetchBackChecksum: expectedChecksum,
  }).outcome, 'verified')
})

test('failed fetch-back retries the existing Drive file and stops at the bounded limit', () => {
  const driveFile = { fileId: 'drive-1', verifiedAt: null }
  const receipt = {
    attempts: 2,
    artifact_checksum: 'a'.repeat(64),
  }
  assert.deepEqual(
    archiveVerificationRetryDecision({ driveFile, receipt }),
    { shouldRetry: true, reason: 'fetch_back_unverified' },
  )
  assert.deepEqual(
    archiveVerificationRetryDecision({
      driveFile,
      receipt: { ...receipt, attempts: 5 },
    }),
    { shouldRetry: false, reason: 'attempt_limit_reached' },
  )
  assert.deepEqual(
    archiveVerificationRetryDecision({
      driveFile: { ...driveFile, verifiedAt: '2026-07-26T00:00:00.000Z' },
      receipt,
    }),
    { shouldRetry: false, reason: 'already_verified' },
  )
})

test('legacy archive verification requires exact fetched-back checksum and size', () => {
  const source = Buffer.from('exact legacy artifact')
  assert.deepEqual(exactArchiveFetchBackEvidence({
    sourceBytes: source,
    fetchBackBytes: Buffer.from(source),
    driveExists: true,
  }), {
    verified: true,
    expectedChecksum: '91f2940f2f2ea3c62b89887399333380edb0045b1f4a4c213e2d328aec84ebc6',
    archiveChecksum: '91f2940f2f2ea3c62b89887399333380edb0045b1f4a4c213e2d328aec84ebc6',
    fetchBackChecksum: '91f2940f2f2ea3c62b89887399333380edb0045b1f4a4c213e2d328aec84ebc6',
    sizeBytes: 21,
    errorCode: null,
  })
  assert.equal(exactArchiveFetchBackEvidence({
    sourceBytes: source,
    fetchBackBytes: Buffer.from('different bytes'),
    driveExists: true,
  }).verified, false)
  assert.equal(exactArchiveFetchBackEvidence({
    sourceBytes: source,
    fetchBackBytes: null,
    driveExists: true,
  }).verified, false)
})

test('archive path collection excludes thumbnails and deduplicates originals', () => {
  assert.deepEqual(
    collectBigPaths({
      storagePath: 'generated/hero.png',
      brandedPath: 'generated/hero.png',
      videoPath: 'generated/reel.mp4',
      thumbPath: 'generated/hero-thumb.webp',
      allPaths: ['generated/hero.png', 'generated/story.png'],
      variants: {
        original: { kind: 'original', storagePath: 'generated/hero.png' },
        branded: { kind: 'branded', storagePath: 'generated/social.jpg' },
        upscaled: { kind: 'upscaled', storagePath: 'generated/hero-4k.png' },
        thumbnail: { kind: 'thumbnail', storagePath: 'generated/thumb-v2.webp' },
      },
    }),
    [
      'generated/hero.png',
      'generated/reel.mp4',
      'generated/story.png',
      'generated/social.jpg',
      'generated/hero-4k.png',
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

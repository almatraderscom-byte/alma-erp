#!/usr/bin/env node

/**
 * CSE7 critical-journey certification.
 *
 * Default mode is a zero-secret structural/API contract check suitable for CI.
 * Set CSE7_BASE_URL + CSE7_AUTH_COOKIE + CSE7_BRAND_PROFILE_ID +
 * CSE7_APPROVED_ASSET_ID to add authenticated preview API proof. The only POST
 * used in live mode is `dry_run`; this script can never publish or spend.
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runCreativeDistributionTick } from '../worker/src/schedulers/creative-performance.mjs'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFile(resolve(root, path), 'utf8')

const files = {
  schema: await read('prisma/schema.prisma'),
  migration: await read('prisma/migrations/20260724220000_creative_distribution_attribution/migration.sql'),
  publishRoute: await read('src/app/api/assistant/creative-studio/publish/route.ts'),
  performanceRoute: await read('src/app/api/assistant/creative-studio/performance/route.ts'),
  retentionRoute: await read('src/app/api/assistant/creative-studio/retention/route.ts'),
  publishService: await read('src/lib/creative-studio/publish-service.ts'),
  archiveWorker: await read('worker/src/schedulers/studio-archive.mjs'),
}

const checks = []
async function check(name, fn) {
  await fn()
  checks.push({ name, status: 'PASS' })
}

await check('schema has exact-version publish and append-only attribution ledgers', () => {
  assert.match(files.schema, /model CreativePublishDelivery/)
  assert.match(files.schema, /assetVersionId\s+String/)
  assert.match(files.schema, /campaignPackId\s+String\?/)
  assert.match(files.schema, /model CreativePerformanceSnapshot/)
  assert.match(files.schema, /sourceFingerprint\s+String\s+@unique/)
})

await check('migration is additive and contains durable archive receipts', () => {
  assert.doesNotMatch(files.migration, /\bDROP\b|\bTRUNCATE\b/i)
  assert.match(files.migration, /CREATE TABLE "creative_archive_receipts"/)
  assert.match(files.migration, /"verified_at" TIMESTAMP\(3\)/)
  assert.match(files.migration, /"original_deleted_at" TIMESTAMP\(3\)/)
})

await check('every CSE7 route checks the agent kill switch or authenticated Studio guard', () => {
  for (const route of [files.publishRoute, files.performanceRoute, files.retentionRoute]) {
    assert.match(route, /requireAgentEnabled|authenticateStudioRequest/)
  }
})

await check('publishing is owner-confirmed, idempotent, and ambiguous retries quarantine', () => {
  assert.match(files.publishService, /confirmedOwnerApproval/)
  assert.match(files.publishService, /ownerId_idempotencyKey/)
  assert.match(files.publishService, /ambiguous_no_auto_retry/)
  assert.match(files.publishService, /ambiguous_worker_interruption/)
})

await check('retention requires a durable receipt before deleting an original', () => {
  const durableCheck = files.archiveWorker.indexOf('durable_verification_required')
  const removeCall = files.archiveWorker.indexOf('.remove([path])')
  assert.ok(durableCheck >= 0)
  assert.ok(removeCall > durableCheck)
  assert.match(files.archiveWorker, /verificationGraceHours/)
})

await check('worker queue admission wakes publishing before metric collection', async () => {
  const calls = []
  await runCreativeDistributionTick({
    appUrl: 'https://contract.invalid',
    internalToken: 'contract-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ processed: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.deepEqual(calls.map((call) => call.body.intent), ['process_due', 'sync_due'])
})

const live = {
  baseUrl: process.env.CSE7_BASE_URL?.replace(/\/+$/, ''),
  cookie: process.env.CSE7_AUTH_COOKIE,
  brandProfileId: process.env.CSE7_BRAND_PROFILE_ID,
  assetId: process.env.CSE7_APPROVED_ASSET_ID,
}

if (Object.values(live).every(Boolean)) {
  const headers = {
    Cookie: live.cookie,
    'Content-Type': 'application/json',
  }
  const history = await fetch(
    `${live.baseUrl}/api/assistant/creative-studio/publish?assetId=${encodeURIComponent(live.assetId)}&brandProfileId=${encodeURIComponent(live.brandProfileId)}`,
    { headers },
  )
  assert.equal(history.status, 200, `publish history HTTP ${history.status}`)
  const performance = await fetch(
    `${live.baseUrl}/api/assistant/creative-studio/performance?assetId=${encodeURIComponent(live.assetId)}&brandProfileId=${encodeURIComponent(live.brandProfileId)}`,
    { headers },
  )
  assert.equal(performance.status, 200, `performance HTTP ${performance.status}`)
  const dryRun = await fetch(`${live.baseUrl}/api/assistant/creative-studio/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      intent: 'dry_run',
      assetId: live.assetId,
      brandProfileId: live.brandProfileId,
      platform: 'facebook',
      pageRef: 'lifestyle',
      caption: 'CSE7 zero-spend live verification',
      scheduledFor: new Date(Date.now() + 60 * 60_000).toISOString(),
      idempotencyKey: `cse7-e2e:${live.assetId}:zero-spend`,
    }),
  })
  assert.equal(dryRun.status, 200, `dry-run HTTP ${dryRun.status}`)
  const dryRunBody = await dryRun.json()
  assert.equal(dryRunBody.preview?.dryRun, true)
  assert.equal(dryRunBody.preview?.receipt?.externalEffect, false)
  assert.equal(dryRunBody.preview?.estimatedCostUsd, 0)
  checks.push({ name: 'authenticated preview GET + zero-effect dry-run API', status: 'PASS' })
} else {
  checks.push({
    name: 'authenticated preview GET + zero-effect dry-run API',
    status: 'DEFERRED_TO_OWNER_CHROME',
  })
}

console.log(JSON.stringify({
  suite: 'creative-studio-cse7-e2e',
  status: checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS',
  spendUsd: 0,
  externalPublishing: false,
  checks,
}, null, 2))

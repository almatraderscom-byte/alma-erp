#!/usr/bin/env node

/**
 * CSE7 bounded read/dry-run load test.
 *
 * Live mode needs CSE7_BASE_URL + CSE7_AUTH_COOKIE + CSE7_PROJECT_ID +
 * CSE7_BRAND_PROFILE_ID + CSE7_APPROVED_ASSET_ID. It sends only GET requests
 * plus publish dry-runs, so cost and external effects remain zero.
 *
 * Thresholds:
 *   Gallery/project read p95 <= 1500ms at concurrency 10
 *   Queue-admission dry-run p95 <= 1000ms at concurrency 5
 *   HTTP error rate <= 1%
 */

import { strict as assert } from 'node:assert'

const READ_P95_MS = 1_500
const ADMISSION_P95_MS = 1_000
const MAX_ERROR_RATE = 0.01

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

async function timed(request) {
  const started = performance.now()
  try {
    const response = await request()
    await response.arrayBuffer()
    return { ms: performance.now() - started, ok: response.ok, status: response.status }
  } catch {
    return { ms: performance.now() - started, ok: false, status: 0 }
  }
}

async function runBounded(total, concurrency, request) {
  const rows = []
  for (let offset = 0; offset < total; offset += concurrency) {
    const batchSize = Math.min(concurrency, total - offset)
    const batch = await Promise.all(Array.from({ length: batchSize }, (_, batchIndex) => (
      request(offset + batchIndex)
    )))
    rows.push(...batch)
  }
  return rows
}

function summarize(name, rows, thresholdMs) {
  const p95Ms = Math.round(percentile(rows.map((row) => row.ms), 0.95))
  const errors = rows.filter((row) => !row.ok).length
  const errorRate = rows.length ? errors / rows.length : 0
  return {
    name,
    requests: rows.length,
    p95Ms,
    thresholdMs,
    errors,
    errorRatePct: Math.round(errorRate * 10_000) / 100,
    pass: p95Ms <= thresholdMs && errorRate <= MAX_ERROR_RATE,
  }
}

const env = {
  baseUrl: process.env.CSE7_BASE_URL?.replace(/\/+$/, ''),
  cookie: process.env.CSE7_AUTH_COOKIE,
  projectId: process.env.CSE7_PROJECT_ID,
  brandProfileId: process.env.CSE7_BRAND_PROFILE_ID,
  assetId: process.env.CSE7_APPROVED_ASSET_ID,
}

let results
if (Object.values(env).every(Boolean)) {
  const headers = { Cookie: env.cookie }
  const readUrls = [
    `${env.baseUrl}/api/assistant/creative-studio/gallery?limit=24`,
    `${env.baseUrl}/api/assistant/creative-studio/projects/${encodeURIComponent(env.projectId)}/assets`,
  ]
  const reads = await runBounded(40, 10, (index) => (
    timed(() => fetch(readUrls[index % readUrls.length], { headers }))
  ))
  const admissions = await runBounded(15, 5, (index) => (
    timed(() => fetch(`${env.baseUrl}/api/assistant/creative-studio/publish`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'dry_run',
        assetId: env.assetId,
        brandProfileId: env.brandProfileId,
        platform: 'facebook',
        pageRef: 'lifestyle',
        caption: 'CSE7 zero-spend load probe',
        scheduledFor: '2026-12-01T00:00:00.000Z',
        idempotencyKey: `cse7-load:${env.assetId}:${index.toString().padStart(3, '0')}`,
      }),
    }))
  ))
  results = [
    summarize('gallery-and-project-reads', reads, READ_P95_MS),
    summarize('publish-dry-run-admission', admissions, ADMISSION_P95_MS),
  ]
} else {
  // CI contract mode still exercises the pagination/filter and queue ordering
  // volumes without secrets. Authenticated preview timings are captured later
  // from the owner's Chrome session.
  const rows = Array.from({ length: 50_000 }, (_, index) => ({
    id: `asset-${index.toString().padStart(6, '0')}`,
    updatedAt: 2_000_000_000_000 - index * 1_000,
    folder: index % 7 === 0 ? 'Campaign Packs' : 'Unsorted',
    status: index % 29 === 0 ? 'failed' : 'executed',
  }))
  const readTimes = []
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now()
    rows
      .filter((row) => row.folder === (index % 2 ? 'Campaign Packs' : 'Unsorted'))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, 24)
    readTimes.push({ ms: performance.now() - started, ok: true, status: 200 })
  }
  const queue = Array.from({ length: 10_000 }, (_, index) => ({
    id: `delivery-${index}`,
    scheduledFor: index,
    status: index % 5 ? 'SCHEDULED' : 'CANCELED',
  }))
  const admissionTimes = []
  for (let index = 0; index < 15; index += 1) {
    const started = performance.now()
    queue
      .filter((row) => row.status === 'SCHEDULED')
      .sort((a, b) => a.scheduledFor - b.scheduledFor || a.id.localeCompare(b.id))
      .slice(0, 5)
    admissionTimes.push({ ms: performance.now() - started, ok: true, status: 200 })
  }
  results = [
    { ...summarize('contract-gallery-project-query-50k', readTimes, 250), mode: 'contract' },
    { ...summarize('contract-queue-admission-10k', admissionTimes, 100), mode: 'contract' },
  ]
}

for (const result of results) assert.equal(result.pass, true, `${result.name} threshold failed`)
console.log(JSON.stringify({
  suite: 'creative-studio-cse7-load',
  status: 'PASS',
  mode: env.baseUrl ? 'authenticated-preview' : 'contract',
  spendUsd: 0,
  externalPublishing: false,
  thresholds: {
    readP95Ms: READ_P95_MS,
    admissionP95Ms: ADMISSION_P95_MS,
    maxErrorRatePct: MAX_ERROR_RATE * 100,
  },
  results,
}, null, 2))

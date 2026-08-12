import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  chooseDurableImageTerminalCallback,
  imageApprovedRecovery,
  isTerminalBullMqFailure,
  makeImageTerminalCallback,
  readImageTerminalCallback,
} from '../image/terminal-callback.mjs'
import { geminiCostTierForImageModel } from '../image/model-cost.mjs'

test('first BullMQ failure is not terminal while another attempt remains', () => {
  assert.equal(isTerminalBullMqFailure({ attemptsMade: 1, opts: { attempts: 2 } }), false)
  assert.equal(isTerminalBullMqFailure({ attemptsMade: 2, opts: { attempts: 2 } }), true)
})

test('durable image terminal envelope replays callback without provider enqueue', () => {
  const marker = makeImageTerminalCallback('success', { storagePath: 'generated/a.png' })
  assert.deepEqual(readImageTerminalCallback({ __imageTerminalCallback: marker }), marker)
  assert.equal(imageApprovedRecovery(marker, 'completed'), 'replay_callback')
})

test('legacy retained terminal job settles failed instead of hanging approved', () => {
  assert.equal(imageApprovedRecovery(null, 'completed'), 'settle_callback_lost')
  assert.equal(imageApprovedRecovery(null, 'failed'), 'settle_callback_lost')
  assert.equal(imageApprovedRecovery(null, 'active'), 'enqueue_or_wait')
})

test('a late queue failure cannot replace or report over a durable success', () => {
  const success = makeImageTerminalCallback('success', { storagePath: 'generated/paid.png' }, undefined, '2026-08-11T00:00:00.000Z')
  const lateFailure = makeImageTerminalCallback('failed', undefined, 'late_failed_event', '2026-08-11T00:01:00.000Z')
  assert.deepEqual(chooseDurableImageTerminalCallback(success, lateFailure), success)
})

test('preview exception uses the durable receipt path before surfacing failure', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8')
  const previewCatch = source.match(/Direct certification dispatch bypasses BullMQ[\s\S]{0,500}?throw err/)
  assert.ok(previewCatch, 'preview image exception block must remain present')
  assert.match(previewCatch[0], /reportImageJobResult\(job\.id, 'failed'/)
  assert.doesNotMatch(previewCatch[0], /await callJobResult\(job\.id, 'failed'/)
})

test('Gemini receipt pricing follows the selected model, not the action quality tier', () => {
  assert.equal(geminiCostTierForImageModel('gemini-3.1-flash-image'), 'standard')
  assert.equal(geminiCostTierForImageModel('gemini-3-pro-image'), 'pro')
})

test('DB outbox failure still falls through to Bull/sidecar caches and canonical callback', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8')
  const reporter = source.match(/async function reportImageJobResult[\s\S]+?\n}\n\nasync function processImageGen/)
  assert.ok(reporter, 'durable image reporter must remain present')
  const dbFailureLog = reporter[0].indexOf('image terminal envelope persist failed')
  const bullCacheWrite = reporter[0].indexOf('queueJob.updateData', dbFailureLog)
  const sidecarWrite = reporter[0].indexOf('persistImageTerminalSidecar', dbFailureLog)
  const canonicalCallback = reporter[0].indexOf('return callJobResult', dbFailureLog)
  assert.ok(dbFailureLog >= 0 && bullCacheWrite > dbFailureLog)
  assert.ok(sidecarWrite > dbFailureLog)
  assert.ok(canonicalCallback > sidecarWrite)
})

test('preview callback-only success counts as processed and never waits the full timeout', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.mjs', import.meta.url)), 'utf8')
  const recovery = source.match(/if \(terminal\) \{[\s\S]{0,1400}?Callback-only recovery/)
  assert.ok(recovery, 'preview callback-only recovery branch must remain present')
  assert.match(recovery[0], /terminal\.status === 'failed'/)
  assert.match(recovery[0], /terminalPreviewImageQcFailure/)
  assert.match(recovery[0], /processedJobs \+= 1/)
})

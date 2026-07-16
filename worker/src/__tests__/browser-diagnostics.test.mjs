/**
 * Phase 48 — worker browser diagnostics.
 * Run: node --test worker/src/__tests__/browser-diagnostics.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeConsole,
  summarizeNetwork,
  classifyFailure,
  evaluateSuccessCriteria,
} from '../browser/diagnostics.mjs'

test('summarizeConsole: errors first, capped, texts truncated', () => {
  const entries = [
    { type: 'log', text: 'hello' },
    { type: 'error', text: 'x'.repeat(500) },
    { type: 'warning', text: 'deprecated api' },
  ]
  const s = summarizeConsole(entries, 5)
  assert.equal(s.errorCount, 1)
  assert.equal(s.warningCount, 1)
  assert.equal(s.totalCount, 3)
  assert.equal(s.samples[0].type, 'error')
  assert.ok(s.samples[0].text.length <= 200)
})

test('summarizeNetwork: failures + redirect chain, capped', () => {
  const reqs = [
    { url: 'https://a.com/ok', status: 200 },
    { url: 'https://a.com/old', status: 301, location: 'https://a.com/new' },
    { url: 'https://a.com/broken', status: 500 },
    { url: 'https://a.com/gone', failed: true, errorText: 'net::ERR_CONNECTION_REFUSED' },
  ]
  const s = summarizeNetwork(reqs)
  assert.equal(s.failureCount, 2)
  assert.equal(s.redirectCount, 1)
  assert.equal(s.redirects[0].location, 'https://a.com/new')
  assert.ok(s.failures.some((f) => f.errorText?.includes('REFUSED')))
})

test('classifyFailure mirrors the TS taxonomy: dns/tls/5xx/auth/permission/selector/timeout/4xx', () => {
  assert.equal(classifyFailure('net::ERR_NAME_NOT_RESOLVED').kind, 'offline_dns')
  assert.equal(classifyFailure('ERR_CERT_AUTHORITY_INVALID').kind, 'tls')
  assert.equal(classifyFailure('HTTP 502 Bad Gateway').kind, 'http_5xx')
  const auth = classifyFailure('401 unauthorized — session expired')
  assert.equal(auth.kind, 'auth_expired')
  assert.equal(auth.ownerFixable, true)
  assert.equal(classifyFailure('403 Forbidden').kind, 'permission_denied')
  assert.equal(classifyFailure('waiting for selector ".submit" timeout').kind, 'selector_broken')
  assert.equal(classifyFailure('task_timeout').kind, 'timeout')
  assert.equal(classifyFailure('HTTP 404 Not Found').kind, 'http_4xx')
  assert.equal(classifyFailure('??').kind, 'unknown')
})

test('evaluateSuccessCriteria: passes only when EVERY criterion holds on the re-read state', () => {
  const criteria = [
    { kind: 'url_matches', pattern: '/done' },
    { kind: 'text_present', text: 'সফল' },
    { kind: 'text_absent', text: 'ব্যর্থ' },
    { kind: 'selector_exists', selector: '.receipt' },
  ]
  const good = evaluateSuccessCriteria(criteria, {
    url: 'https://x.com/task/done',
    visibleText: 'কাজ সফল হয়েছে',
    presentSelectors: ['.receipt'],
  })
  assert.equal(good.passed, true)

  const bad = evaluateSuccessCriteria(criteria, {
    url: 'https://x.com/task/error',
    visibleText: 'কাজ ব্যর্থ',
    presentSelectors: [],
  })
  assert.equal(bad.passed, false)
  assert.ok(bad.results.filter((r) => !r.passed).length >= 3)
})

test('evaluateSuccessCriteria: empty criteria never auto-pass; unknown kinds fail closed', () => {
  assert.equal(evaluateSuccessCriteria([], { url: 'x', visibleText: '', presentSelectors: [] }).passed, false)
  const r = evaluateSuccessCriteria([{ kind: 'magic' }], { url: 'x', visibleText: '', presentSelectors: [] })
  assert.equal(r.passed, false)
  assert.ok(r.results[0].detail.includes('unknown'))
})

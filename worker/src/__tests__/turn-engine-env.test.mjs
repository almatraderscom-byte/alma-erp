// VPS model-loop V1 — the worker's engine routing + slice-fetch timeout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { getTurnEngineUrl, getTurnFetchTimeoutMs, getAppUrl } from '../env.mjs'

test('getTurnEngineUrl falls back to APP_URL when no engine is configured', () => {
  process.env.APP_URL = 'https://app.example'
  delete process.env.WORKER_TURN_ENGINE_URL
  assert.equal(getTurnEngineUrl(), 'https://app.example')
  assert.equal(getTurnEngineUrl(), getAppUrl())
})

test('getTurnEngineUrl prefers the configured engine and strips a trailing slash', () => {
  process.env.APP_URL = 'https://app.example'
  process.env.WORKER_TURN_ENGINE_URL = 'http://127.0.0.1:3100/'
  assert.equal(getTurnEngineUrl(), 'http://127.0.0.1:3100')
  delete process.env.WORKER_TURN_ENGINE_URL
})

test('a blank engine value never produces an empty URL', () => {
  process.env.APP_URL = 'https://app.example'
  process.env.WORKER_TURN_ENGINE_URL = '   '
  assert.equal(getTurnEngineUrl(), 'https://app.example')
  delete process.env.WORKER_TURN_ENGINE_URL
})

test('turn fetch timeout defaults above the engine 1h slice cap and rejects nonsense', () => {
  delete process.env.WORKER_TURN_FETCH_TIMEOUT_MS
  assert.equal(getTurnFetchTimeoutMs(), 65 * 60 * 1000)
  process.env.WORKER_TURN_FETCH_TIMEOUT_MS = String(2 * 60 * 60 * 1000)
  assert.equal(getTurnFetchTimeoutMs(), 2 * 60 * 60 * 1000)
  process.env.WORKER_TURN_FETCH_TIMEOUT_MS = '10'
  assert.equal(getTurnFetchTimeoutMs(), 65 * 60 * 1000)
  delete process.env.WORKER_TURN_FETCH_TIMEOUT_MS
})

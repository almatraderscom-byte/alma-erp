/**
 * Regression lock for the pending-jobs dispatch gate.
 *
 * The historic bug (caught by the P2 e2e): the worker handled `workbench_run`
 * but the internal pending-jobs route's `type: { in: [...] }` list didn't
 * include it — so every workbench job sat at status=approved forever and hit
 * the stuck-task watchdog instead of running. The route's list is the SINGLE
 * gate between "queued" and "the worker ever sees it".
 *
 * This test pins the contract at the source level: every job type the worker
 * dispatches on (`job.type === '...'` in worker/src/index.mjs pollPendingJobs)
 * must appear in the route's type list.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

function routeTypeList(): string[] {
  const src = readFileSync(
    join(ROOT, 'src/app/api/assistant/internal/pending-jobs/route.ts'),
    'utf8',
  )
  const m = src.match(/type:\s*\{\s*in:\s*\[([^\]]+)\]/)
  if (!m) throw new Error('pending-jobs route: type-in list not found')
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
}

function workerHandledTypes(): string[] {
  const src = readFileSync(join(ROOT, 'worker/src/index.mjs'), 'utf8')
  return Array.from(new Set(Array.from(src.matchAll(/job\.type === '([^']+)'/g)).map((x) => x[1])))
}

describe('pending-jobs dispatch gate', () => {
  it('every worker-handled job type is in the route dispatch list', () => {
    const route = new Set(routeTypeList())
    const missing = workerHandledTypes().filter((t) => !route.has(t))
    expect(missing, `worker handles these types but pending-jobs never dispatches them: ${missing.join(', ')}`).toEqual([])
  })

  it('workbench_run stays dispatched (the P2 regression)', () => {
    expect(routeTypeList()).toContain('workbench_run')
  })
})

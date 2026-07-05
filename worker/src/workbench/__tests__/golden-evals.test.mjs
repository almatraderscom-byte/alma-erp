/**
 * P5 golden evals — the suite runs through the REAL executor and returns a
 * deterministic pass/fail per golden. Run offline-safe (net golden skipped):
 *   node --test src/workbench/__tests__/golden-evals.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WORKBENCH_ROOT = await mkdtemp(join(tmpdir(), 'alma-golden-test-'))
const { runGoldenEvals } = await import('../golden-evals.mjs')

test('offline goldens pass through the real executor', async () => {
  const { passed, failed } = await runGoldenEvals({ skip: ['net-fetch'] })
  assert.deepEqual(failed, [], `golden regressions: ${JSON.stringify(failed)}`)
  assert.ok(passed.includes('node-compute'))
  assert.ok(passed.includes('python-compute'))
  assert.ok(passed.includes('artifact-flow'))
})

test('skip filter works (a skipped golden neither passes nor fails)', async () => {
  const { passed, failed } = await runGoldenEvals({
    skip: ['net-fetch', 'python-compute', 'artifact-flow'],
  })
  assert.deepEqual(failed, [])
  assert.deepEqual(passed, ['node-compute'])
})

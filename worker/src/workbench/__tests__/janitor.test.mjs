/**
 * P2 workspace janitor — age-based cleanup of kept/failed workbench workspaces.
 * Run with:  WORKBENCH_ROOT=... node --test src/workbench/__tests__/janitor.test.mjs
 * (the test sets its own temp WORKBENCH_ROOT before importing the executor).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'alma-workbench-test-'))
process.env.WORKBENCH_ROOT = root
const { cleanupWorkspaces } = await import('../executor.mjs')

test('removes workspaces older than the keep window, keeps fresh ones', async () => {
  const oldDir = join(root, 'wb-old-task')
  const newDir = join(root, 'wb-new-task')
  await mkdir(oldDir, { recursive: true })
  await writeFile(join(oldDir, 'out.txt'), 'stale artifact')
  await mkdir(newDir, { recursive: true })
  await writeFile(join(newDir, 'out.txt'), 'fresh artifact')

  // age the old workspace 10 days (keep window defaults to 7)
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await utimes(oldDir, tenDaysAgo, tenDaysAgo)

  const { removed, kept } = await cleanupWorkspaces()
  assert.equal(removed, 1)
  assert.equal(kept, 1)

  const left = await readdir(root)
  assert.deepEqual(left.sort(), ['wb-new-task'])
})

test('success WITH artifacts requested keeps the workspace for the uploader (P2 e2e bug)', async () => {
  const { runWorkbenchTask } = await import('../executor.mjs')
  const res = await runWorkbenchTask({
    taskId: 'keep-for-artifacts',
    commands: [{ bin: 'ls', args: [] }],
    artifacts: ['report.json'],
  })
  assert.equal(res.ok, true)
  // workspace must still exist — the worker reads artifact files AFTER this returns
  const left = await readdir(root)
  assert.ok(left.includes('keep-for-artifacts'), 'workspace was deleted before artifact upload')
})

test('success WITHOUT artifacts cleans the workspace immediately', async () => {
  const { runWorkbenchTask } = await import('../executor.mjs')
  const res = await runWorkbenchTask({
    taskId: 'ephemeral-run',
    commands: [{ bin: 'ls', args: [] }],
  })
  assert.equal(res.ok, true)
  const left = await readdir(root)
  assert.ok(!left.includes('ephemeral-run'), 'ephemeral workspace should be removed on success')
})

test('missing root is a no-op, never a throw', async () => {
  process.env.WORKBENCH_ROOT = join(root, 'does-not-exist')
  // module already imported with the original root — call against existing root
  // is covered above; this guards the readdir-failure branch via a fresh import.
  const fresh = await import('../executor.mjs?fresh=' + Date.now())
  const res = await fresh.cleanupWorkspaces()
  assert.deepEqual(res, { removed: 0, kept: 0 })
})

/**
 * P5 golden-task eval suite — fixed benchmark tasks that run WEEKLY on the VPS
 * so a regression in the workbench (missing binary, broken executor policy,
 * artifact flow) is caught BEFORE the owner hits it (roadmap P5).
 *
 * Each golden runs through the REAL executor (same allowlist/caps/env-scrub as
 * production jobs) and asserts a deterministic expectation. The suite never
 * throws — it returns {passed, failed[]} and the scheduler notifies the owner
 * only when something regressed.
 */
import { runWorkbenchTask } from './executor.mjs'

/** One golden = a real workbench task + a deterministic assertion on its result. */
const GOLDENS = [
  {
    id: 'node-compute',
    task: {
      taskId: 'golden-node-compute',
      commands: [{ bin: 'node', args: ['-e', "console.log('golden:' + (6 * 7))"] }],
    },
    assert: (r) => (r.ok && r.steps[0]?.stdout?.includes('golden:42') ? null : 'node compute wrong/failed'),
  },
  {
    id: 'python-compute',
    task: {
      taskId: 'golden-python-compute',
      commands: [{ bin: 'python3', args: ['-c', "print('golden:' + str(6 * 7))"] }],
    },
    assert: (r) => (r.ok && r.steps[0]?.stdout?.includes('golden:42') ? null : 'python3 compute wrong/failed'),
  },
  {
    id: 'artifact-flow',
    task: {
      taskId: 'golden-artifact-flow',
      files: [{ path: 'write.mjs', content: "import { writeFile } from 'node:fs/promises'\nawait writeFile('out.json', JSON.stringify({ golden: true }))\nconsole.log('written')\n" }],
      commands: [
        { bin: 'node', args: ['write.mjs'] },
        { bin: 'cat', args: ['out.json'] },
      ],
      // artifacts requested → executor must KEEP the workspace (the P2 e2e bug class)
      artifacts: ['out.json'],
    },
    assert: (r) => {
      if (!r.ok) return 'artifact task failed'
      if (!r.steps[1]?.stdout?.includes('"golden":true')) return 'artifact file content wrong'
      return null
    },
    // this golden keeps its workspace (artifacts requested) — clean it ourselves
    cleanup: true,
  },
  {
    id: 'net-fetch',
    task: {
      taskId: 'golden-net-fetch',
      commands: [{ bin: 'curl', args: ['-s', '-o', 'page.html', '-w', '%{http_code}', 'https://example.com'] }],
    },
    assert: (r) => (r.ok && r.steps[0]?.stdout?.trim() === '200' ? null : 'public fetch not 200'),
  },
]

/**
 * @param {{ skip?: string[] }} [opts] skip golden ids (tests skip net-dependent ones)
 * @returns {Promise<{passed: string[], failed: Array<{id: string, reason: string}>}>}
 */
export async function runGoldenEvals(opts = {}) {
  const skip = new Set(opts.skip ?? [])
  const passed = []
  const failed = []
  for (const golden of GOLDENS) {
    if (skip.has(golden.id)) continue
    try {
      const result = await runWorkbenchTask(golden.task)
      const problem = golden.assert(result)
      if (problem) failed.push({ id: golden.id, reason: `${problem} (${result.error ?? 'no error'})` })
      else passed.push(golden.id)
      if (golden.cleanup && result.workspace) {
        const { rm } = await import('node:fs/promises')
        await rm(result.workspace, { recursive: true, force: true }).catch(() => {})
      }
    } catch (err) {
      failed.push({ id: golden.id, reason: `threw: ${err.message}` })
    }
  }
  return { passed, failed }
}

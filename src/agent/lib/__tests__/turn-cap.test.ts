/**
 * VPS model-loop V0/V1 — the per-slice budget for a worker-driven rerun.
 * On Vercel the platform kill is real: the env may never push the cap past
 * maxDuration. On the self-hosted engine there is no platform kill, and the
 * declared flag is the ONLY thing that unlocks the env-driven budget.
 */
import { describe, expect, it } from 'vitest'
import { isSelfHostedEngine, resolveWorkerRerunCapMs } from '@/agent/lib/turn-cap'

describe('resolveWorkerRerunCapMs', () => {
  it('on Vercel: full function budget minus the 20s persist headroom', () => {
    expect(resolveWorkerRerunCapMs(1800, {} as unknown as NodeJS.ProcessEnv)).toBe(1780 * 1000)
    expect(resolveWorkerRerunCapMs(800, {} as unknown as NodeJS.ProcessEnv)).toBe(780 * 1000)
  })

  it('the env alone can NEVER exceed the Vercel budget — the flag is required', () => {
    expect(resolveWorkerRerunCapMs(1800, {
      AGENT_WORKER_RERUN_CAP_MS: String(4 * 60 * 60 * 1000),
    } as unknown as NodeJS.ProcessEnv)).toBe(1780 * 1000)
  })

  it('self-hosted engine: env budget wins, defaulting to 1 hour', () => {
    expect(resolveWorkerRerunCapMs(1800, {
      ALMA_SELF_HOSTED_ENGINE: '1',
    } as unknown as NodeJS.ProcessEnv)).toBe(60 * 60 * 1000)
    expect(resolveWorkerRerunCapMs(1800, {
      ALMA_SELF_HOSTED_ENGINE: '1',
      AGENT_WORKER_RERUN_CAP_MS: String(2 * 60 * 60 * 1000),
    } as unknown as NodeJS.ProcessEnv)).toBe(2 * 60 * 60 * 1000)
  })

  it('a nonsense engine env falls back to the default instead of a tiny/broken cap', () => {
    for (const bad of ['0', '-5', 'abc', '1000']) {
      expect(resolveWorkerRerunCapMs(1800, {
        ALMA_SELF_HOSTED_ENGINE: '1',
        AGENT_WORKER_RERUN_CAP_MS: bad,
      } as unknown as NodeJS.ProcessEnv)).toBe(60 * 60 * 1000)
    }
  })

  it('isSelfHostedEngine only accepts the exact declaration', () => {
    expect(isSelfHostedEngine({ ALMA_SELF_HOSTED_ENGINE: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(isSelfHostedEngine({ ALMA_SELF_HOSTED_ENGINE: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isSelfHostedEngine({} as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
})

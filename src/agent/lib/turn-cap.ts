/**
 * Per-slice execution budget for a WORKER-driven rerun of an existing turn
 * (the VPS long-turn lane calling back into the chat route).
 *
 * On Vercel the platform kills the function at `maxDuration`, so the cap must
 * stay under it with persistence headroom — no env may override that (a
 * mismatched env would let the platform kill the request mid-write).
 *
 * On the SELF-HOSTED engine (VPS model loop, docs/VPS_MODEL_LOOP.md) there is
 * no platform ceiling at all. The process declares itself with
 * `ALMA_SELF_HOSTED_ENGINE=1`, and the slice budget becomes
 * `AGENT_WORKER_RERUN_CAP_MS` (default 1 hour). A cap still exists on purpose:
 * a wedged provider stream must end in a salvage + durable hop, never hang a
 * worker slot forever — the hop chain is what makes total runtime unbounded,
 * not one infinite slice.
 */

const SELF_HOSTED_DEFAULT_CAP_MS = 60 * 60 * 1000
/** Floor guard: a nonsense env must not produce a cap too small to do work. */
const SELF_HOSTED_MIN_CAP_MS = 60 * 1000

export function isSelfHostedEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ALMA_SELF_HOSTED_ENGINE ?? '').trim() === '1'
}

export function resolveWorkerRerunCapMs(
  maxDurationSec: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (isSelfHostedEngine(env)) {
    const raw = Number(env.AGENT_WORKER_RERUN_CAP_MS)
    if (Number.isFinite(raw) && raw >= SELF_HOSTED_MIN_CAP_MS) return raw
    return SELF_HOSTED_DEFAULT_CAP_MS
  }
  return (maxDurationSec - 20) * 1000
}

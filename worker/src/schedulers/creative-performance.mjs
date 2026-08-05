/**
 * CSE7 distribution tick.
 *
 * The VPS owns long-running cadence; the app owns auth, policy, exact-once
 * claims, Meta calls, and database transactions. This worker therefore sends
 * only two authenticated, bounded wakeups:
 *   1) process owner-approved due publishes
 *   2) refresh performance for verified delivery receipts
 *
 * Rollout is explicitly gated by STUDIO_DISTRIBUTION_SCHEDULERS_ENABLED=true.
 */

function endpoint(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`
}

async function postTick(fetchImpl, url, token, body) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-internal-token': token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}:${payload.error ?? 'unknown'}`)
  }
  return payload
}

export async function runCreativeDistributionTick({
  appUrl,
  internalToken,
  fetchImpl = fetch,
}) {
  if (!appUrl || !internalToken) {
    return { status: 'skipped', reason: 'app_url_or_internal_token_missing' }
  }
  const startedAt = new Date().toISOString()
  const publish = await postTick(
    fetchImpl,
    endpoint(appUrl, '/api/assistant/creative-studio/publish'),
    internalToken,
    { intent: 'process_due', limit: 5 },
  )
  const performance = await postTick(
    fetchImpl,
    endpoint(appUrl, '/api/assistant/creative-studio/performance'),
    internalToken,
    { intent: 'sync_due', limit: 10 },
  )
  return {
    status: 'done',
    startedAt,
    publish,
    performance,
  }
}

export function startCreativeDistributionLoop({
  appUrl,
  internalToken,
  fetchImpl = fetch,
  intervalMs = 5 * 60_000,
  runImmediately = true,
}) {
  const tick = async () => {
    try {
      const result = await runCreativeDistributionTick({
        appUrl,
        internalToken,
        fetchImpl,
      })
      console.log(
        '[creative-distribution] tick done —',
        `${result.publish?.processed ?? 0} publish, ${result.performance?.inserted ?? 0} metric snapshots`,
      )
    } catch (error) {
      console.error(
        '[creative-distribution] tick failed:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  if (runImmediately) void tick()
  return setInterval(tick, Math.max(60_000, Number(intervalMs) || 5 * 60_000))
}

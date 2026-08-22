/**
 * VPS-executed long turn (Component A2).
 *
 * Runs a turn enqueued by /api/assistant/turn. We call back into the existing
 * chat route in STREAM mode (passing the turnId the enqueue route created, which
 * authorizes this internal call on a web conversation and reuses the same turn
 * row), then republish every SSE event two ways:
 *   - Redis pub/sub  `turn:<turnId>:events`  → live tail for a connected client
 *   - agent_turn_events row (seq-keyed)      → durable replay for reconnects
 *
 * The chat route itself finalizes the AgentTurn status (it's running the turn),
 * so we only mirror events + ping the owner when a slow turn finishes. There is
 * no pending_actions row for a turn job, so we don't call the job-result
 * callback — the durable turn status + event log are the source of truth.
 *
 * Durability contract (reliability epic R-3, handoff F-09/F-10/F-11):
 *   - every event is appended durably BEFORE it is published; a PostgREST
 *     `{ error }` is a failure (retried with backoff), never silently a success;
 *   - an event that cannot be stored is NOT published and does not consume a
 *     seq — the live tail and the replay log never disagree;
 *   - `agent_turns.last_seq` is bumped after every durable append (the same
 *     liveness semantics as inline execution), so a duplicate /turn request can
 *     tell a healthy worker from a dead one and replay paging knows the tail;
 *   - a BullMQ retry resumes seq from the durable max instead of restarting at
 *     zero over a generative prior run;
 *   - an upstream stream that ends without `done`/`error` is reported as an
 *     `error` (`turn_stream_ended_without_terminal`), never as synthetic success.
 */
const DURABLE_WRITE_ATTEMPTS = 3
const DURABLE_RETRY_DELAYS_MS = [50, 200, 600]
/**
 * A TERMINAL row is the one write that may not be given up on quickly: the
 * chat route has already finalized the turn by then, so a BullMQ retry would
 * be skipped by the worker's status guard and no later attempt could repair the
 * log (Codex P1 #837). Keep trying in-process for ~1 minute before rejecting.
 */
const TERMINAL_WRITE_ATTEMPTS = 8
/** Repair-job enqueue after a lost terminal: the last durable retry path. */
const REPAIR_ENQUEUE_ATTEMPTS = 3
const REPAIR_ENQUEUE_DELAYS_MS = [1000, 3000]
const TERMINAL_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 16000]

import Redis from 'ioredis'
import { getAppUrl, getInternalToken } from '../env.mjs'

const SLOW_TURN_MS = 30_000

function turnEventChannel(turnId) {
  return `turn:${turnId}:events`
}

/**
 * @param {object} args
 * @param {import('@supabase/supabase-js').SupabaseClient} args.supabase
 * @param {object} args.job                BullMQ job; job.data carries the turn payload
 * @param {string} args.redisUrl
 * @param {object|null} args.telegramBot
 * @param {{ fetch?: typeof fetch, publisher?: { publish: Function, quit: Function, disconnect?: Function }, sleep?: (ms: number) => Promise<void> }} [args.deps]
 *        Test seams only — production passes nothing and gets the real Redis/fetch.
 */
export async function runStreamedTurn({ supabase, job, redisUrl, telegramBot, deps = {} }) {
  const { turnId, conversationId, message, files, projectId, personalMode, clientRequestId, askCardId, internalControl, agentProseProtocol } = job.data ?? {}
  if (!turnId || !conversationId || !message) {
    console.warn(`[worker] streamed-turn ${job?.id} — missing turnId/conversationId/message`)
    return
  }

  const fetchImpl = deps.fetch ?? fetch
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const publisher = deps.publisher ?? new Redis(redisUrl, { maxRetriesPerRequest: null })
  const startedAt = Date.now()
  let sawDone = false
  let sawError = null
  let durableHoles = 0
  /** 'done' | 'error' whose durable write failed every attempt. */
  let terminalLost = null
  /** The terminal event itself, so the repair job can store it verbatim. */
  let lostTerminalEvent = null
  let repairScheduled = false
  const enqueueRepair = deps.enqueueRepair ?? ((data) => enqueueTerminalRepair({ redisUrl, data }))

  // Codex P1 #837 r3: the turn job is enqueued with attempts:1 (a turn is not
  // idempotent), so a throw here is BullMQ's final word — the finished-turn
  // guard and `repairMissingTerminal()` would never run. A lost terminal is
  // handed to its own retrying, repair-only job instead; it never re-runs the
  // turn. Failing to enqueue it must not mask the original failure.
  async function scheduleTerminalRepair({ status, terminal }) {
    if (repairScheduled) return
    repairScheduled = true
    // The turn job has attempts:1, so this enqueue is the only durable retry
    // path left: a transient Redis hiccup must not end it (Codex P1 #837 r5).
    let lastError = null
    for (let attempt = 0; attempt < REPAIR_ENQUEUE_ATTEMPTS; attempt++) {
      try {
        await enqueueRepair({ turnId, status, terminal })
        console.warn(`[worker] streamed-turn ${turnId} — terminal repair job enqueued (${status})`)
        return
      } catch (err) {
        lastError = err
      }
      if (attempt < REPAIR_ENQUEUE_ATTEMPTS - 1) await sleep(REPAIR_ENQUEUE_DELAYS_MS[attempt] ?? 3000)
    }
    // Postgres AND Redis both down: nothing durable is reachable. Say so loudly
    // — the operator alert is the remaining path (never swallow it silently).
    console.error(`[worker] streamed-turn ${turnId} — terminal repair enqueue FAILED after ${REPAIR_ENQUEUE_ATTEMPTS} attempts (turn has NO durable terminal):`, lastError?.message ?? lastError)
  }

  // A retried job must continue the durable sequence, never overwrite rows a
  // previous attempt already wrote (upsert with update:{} would keep the old
  // payload under the new event's seq — a corrupted replay).
  let seq = 0
  try {
    const { data, error } = await supabase
      .from('agent_turn_events')
      .select('seq')
      .eq('turn_id', turnId)
      .order('seq', { ascending: false })
      .limit(1)
    if (error) throw error
    const maxSeq = Array.isArray(data) && data.length > 0 && typeof data[0]?.seq === 'number' ? data[0].seq : -1
    seq = maxSeq + 1
    if (seq > 0) console.warn(`[worker] streamed-turn ${turnId} — resuming durable seq at ${seq}`)
  } catch (err) {
    console.warn(`[worker] streamed-turn ${turnId} — durable seq lookup failed (starting at 0):`, err?.message ?? err)
  }

  async function storeDurably(row, { terminal = false } = {}) {
    const attempts = terminal ? TERMINAL_WRITE_ATTEMPTS : DURABLE_WRITE_ATTEMPTS
    const delays = terminal ? TERMINAL_RETRY_DELAYS_MS : DURABLE_RETRY_DELAYS_MS
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const { error } = await supabase.from('agent_turn_events').upsert(row, { onConflict: 'turn_id,seq' })
        if (!error) return true
        lastError = error
      } catch (err) {
        lastError = err
      }
      if (attempt < attempts - 1) await sleep(delays[attempt] ?? 500)
    }
    console.error(`[worker] streamed-turn ${turnId} — durable write seq ${row.seq} FAILED after ${attempts} attempts:`, lastError?.message ?? lastError)
    return false
  }

  async function emit(event) {
    const type = typeof event?.type === 'string' ? event.type : 'unknown'
    const row = {
      id: `${turnId}:${seq}`,
      turn_id: turnId,
      seq,
      type,
      payload: event,
    }
    // Durable first (replay must not miss an event the live tail already lost),
    // then publish, then the liveness stamp. An event we could not store is not
    // published and does not consume its seq: what the tail shows, the log has.
    const stored = await storeDurably(row, { terminal: type === 'done' || type === 'error' })
    if (!stored) {
      durableHoles += 1
      return false
    }
    try {
      await publisher.publish(turnEventChannel(turnId), JSON.stringify({ seq, type, payload: event }))
    } catch (err) {
      console.warn(`[worker] streamed-turn ${turnId} — publish seq ${seq} failed:`, err.message)
    }
    try {
      const { error } = await supabase.from('agent_turns').update({ last_seq: seq }).eq('id', turnId)
      if (error) console.warn(`[worker] streamed-turn ${turnId} — last_seq ${seq} update failed:`, error.message ?? error)
    } catch (err) {
      console.warn(`[worker] streamed-turn ${turnId} — last_seq ${seq} update failed:`, err.message)
    }
    seq += 1
    return true
  }

  try {
    const res = await fetchImpl(`${getAppUrl()}/api/assistant/chat?stream=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ conversationId, message, files, projectId, personalMode, turnId, clientRequestId, askCardId, internalControl, agentProseProtocol }),
      // Generous cap for genuinely long turns — this is the whole point of A2.
      signal: AbortSignal.timeout(25 * 60 * 1000),
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => 'no body')
      throw new Error(`chat API ${res.status}: ${String(text).slice(0, 200)}`)
    }

    // Parse the SSE byte stream into discrete `data:` events.
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue // skip ": ping" keepalives
          const json = line.slice(5).trim()
          if (!json) continue
          let event
          try {
            event = JSON.parse(json)
          } catch {
            continue
          }
          const stored = await emit(event)
          // A terminal counts only once it is durable (Codex P1 #837): an
          // unstored `done`/`error` must not let this job resolve while the
          // tailing client waits forever for a terminal that never reached
          // the log.
          if (stored) {
            if (event?.type === 'done') sawDone = true
            else if (event?.type === 'error') sawError = event.message || 'turn_error'
          } else if (event?.type === 'done' || event?.type === 'error') {
            terminalLost = event.type
            lostTerminalEvent = event
          }
        }
      }
    }

    // The upstream stream ended without a (durable) terminal event: the turn
    // died (hard cap, crash, cancel) or its terminal could not be stored. Say
    // so — a synthetic `done` without a messageId used to tell the client a
    // canceled/partial turn had succeeded.
    if (!sawDone && !sawError) {
      const message = terminalLost ? `turn_terminal_not_durable:${terminalLost}` : 'turn_stream_ended_without_terminal'
      const stored = await emit({ type: 'error', message })
      if (!stored) {
        // Nothing durable marks this turn finished. Hand the terminal to the
        // repair job (the real `done`/`error` when we have it) and surface the
        // failure to BullMQ instead of resolving as if it had succeeded.
        await scheduleTerminalRepair({
          status: terminalLost === 'done' ? 'done' : 'error',
          terminal: lostTerminalEvent ?? { type: 'error', message },
        })
        throw new Error(`streamed-turn ${turnId}: terminal event could not be stored durably`)
      }
      sawError = message
    }

    console.log(`[worker] streamed-turn ${turnId} — ${sawError ? `ended with error "${sawError}"` : 'done'} (${seq} events, ${durableHoles} durable holes, ${Date.now() - startedAt}ms)`)
  } catch (err) {
    sawError = err.message
    console.error(`[worker] streamed-turn ${turnId} failed:`, err.message)
    // The EOF path above already spent the terminal budget and scheduled the
    // repair — a second 8-attempt write of the same failure is pure delay.
    if (repairScheduled) throw err
    const stored = await emit({ type: 'error', message: err.message })
    if (!stored) {
      await scheduleTerminalRepair({ status: 'error', terminal: { type: 'error', message: err.message } })
      throw err
    }
  } finally {
    // Owner ping for a slow turn that finished while they were away (mirrors A1).
    const elapsed = Date.now() - startedAt
    if (sawDone && !sawError && elapsed > SLOW_TURN_MS && telegramBot) {
      const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
      if (chatId) {
        await telegramBot.telegram
          .sendMessage(chatId, '✅ আপনার দীর্ঘ কাজটি শেষ হয়েছে বস — অ্যাপ খুললেই উত্তরটা দেখতে পাবেন।')
          .catch((e) => console.warn('[worker] streamed-turn notify failed:', e.message))
      }
    }
    try {
      await publisher.quit()
    } catch {
      publisher.disconnect?.()
    }
  }
}

/**
 * Enqueue the repair-only job for a turn whose terminal could not be stored
 * (Codex P1 #837 r3). Same queue as the turn itself, but its own job name and
 * a real retry budget with backoff — PostgREST outages that outlast the
 * in-process terminal budget are exactly what it is for. Deterministic jobId:
 * one outstanding repair per turn.
 */
export async function enqueueTerminalRepair({ redisUrl, data }) {
  const { Queue } = await import('bullmq')
  // Producer-only connection: fail fast instead of queueing commands against a
  // Redis that is down — the caller is already on a failure path and must not
  // hang behind ioredis' infinite reconnect.
  const queue = new Queue('long-agent-task', {
    connection: {
      url: redisUrl,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 3 ? null : 500),
    },
  })
  try {
    const job = await queue.add('repair-terminal', data, {
      jobId: `repair-${data.turnId}`,
      attempts: 10,
      backoff: { type: 'exponential', delay: 5000 },
      priority: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    })
    return job.id ?? null
  } finally {
    await queue.close().catch(() => {})
  }
}

/**
 * Repair path for a turn that already reached a terminal status while its
 * durable event log has no terminal row (the original write failed every
 * attempt; reached via the repair job or a re-delivered turn job). Writes
 * exactly one terminal row with the next seq — the carried `terminal` event
 * verbatim when the caller has it, else a synthesized error — and PUBLISHES it
 * on the turn channel: a tail that already subscribed never polls the log
 * (Codex P1 #837 r3), so a row alone would leave it on keepalives. Never
 * re-runs the turn. Idempotent: a log that already ends with a terminal is
 * left alone.
 *
 * @returns {Promise<{ outcome: 'repaired' | 'already_terminal' | 'failed', seq?: number, error?: string }>}
 */
export async function repairMissingTerminal({ supabase, turnId, status, terminal = null, publisher = null, redisUrl = null, sleep = null, publishTimeoutMs = REPAIR_PUBLISH_TIMEOUT_MS }) {
  try {
    // A terminal is a terminal wherever it sits: the chat route emits
    // `conversation_compacted` AFTER `done` and the worker mirrors both, so the
    // LAST row is not the right question (Codex P1 #837 r4).
    const { data: terminals, error: terminalError } = await supabase
      .from('agent_turn_events')
      .select('seq,type,payload')
      .eq('turn_id', turnId)
      .in('type', ['done', 'error'])
      .order('seq', { ascending: false })
      .limit(1)
    if (terminalError) throw terminalError
    const existing = Array.isArray(terminals) && terminals.length > 0 ? terminals[0] : null
    if (existing) {
      // Idempotent for the log — but a retry after a failed publish must still
      // reach the subscribed tails, so the existing terminal is (re)published;
      // tails dedupe by seq.
      const published = await publishRepairedTerminal({ turnId, row: existing, publisher, redisUrl, sleep, publishTimeoutMs })
      if (!published) return { outcome: 'failed', seq: existing.seq, error: 'terminal present but not published' }
      return { outcome: 'already_terminal', seq: existing.seq }
    }
    const { data, error } = await supabase
      .from('agent_turn_events')
      .select('seq,type')
      .eq('turn_id', turnId)
      .order('seq', { ascending: false })
      .limit(1)
    if (error) throw error
    const last = Array.isArray(data) && data.length > 0 ? data[0] : null
    const seq = last && typeof last.seq === 'number' ? last.seq + 1 : 0
    const carried = terminal && (terminal.type === 'done' || terminal.type === 'error') ? terminal : null
    const payload = carried ?? {
      type: 'error',
      message: status === 'done' ? 'turn_terminal_repaired:done' : `turn_terminal_repaired:${status}`,
    }
    const row = { id: `${turnId}:${seq}`, turn_id: turnId, seq, type: payload.type, payload }
    const { error: writeError } = await supabase.from('agent_turn_events').upsert(row, { onConflict: 'turn_id,seq' })
    if (writeError) throw writeError
    await supabase.from('agent_turns').update({ last_seq: seq }).eq('id', turnId)
    console.warn(`[worker] streamed-turn ${turnId} — repaired missing terminal at seq ${seq} (${payload.type})`)
    // The row is durable, but a tail that already subscribed never polls the
    // log: an unpublished repair is NOT complete — report failure so the job
    // retries (the retry takes the already_terminal → republish path).
    const published = await publishRepairedTerminal({ turnId, row, publisher, redisUrl, sleep, publishTimeoutMs })
    if (!published) return { outcome: 'failed', seq, error: 'terminal repaired but not published' }
    return { outcome: 'repaired', seq }
  } catch (err) {
    console.error(`[worker] streamed-turn ${turnId} — terminal repair failed:`, err?.message ?? err)
    return { outcome: 'failed', error: err?.message ?? String(err) }
  }
}

const REPAIR_PUBLISH_ATTEMPTS = 3
const REPAIR_PUBLISH_DELAYS_MS = [250, 750]
/** A publish that has not returned by then is treated as failed — never let a
 *  reconnecting client park the (concurrency-1) worker (Codex P1 #837 r5). */
const REPAIR_PUBLISH_TIMEOUT_MS = 5000

function withTimeout(promise, ms, label) {
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer) })
}

/** @returns {Promise<boolean>} true when published (or no channel was configured — nothing to reach). */
async function publishRepairedTerminal({ turnId, row, publisher, redisUrl, sleep, publishTimeoutMs = REPAIR_PUBLISH_TIMEOUT_MS }) {
  // A repair-owned client must fail fast: maxRetriesPerRequest:null (right for
  // the live publisher of a running turn) would keep the first publish pending
  // across reconnect attempts and the retry loop would never advance.
  const owned = !publisher && redisUrl
    ? new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: Math.min(publishTimeoutMs, 5000),
        retryStrategy: (times) => (times > 3 ? null : 500),
      })
    : null
  if (owned) owned.on('error', () => { /* surfaced by the failed publish */ })
  const client = publisher ?? owned
  if (!client) return true
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const message = JSON.stringify({ seq: row.seq, type: row.type, payload: row.payload })
  try {
    let lastError = null
    for (let attempt = 0; attempt < REPAIR_PUBLISH_ATTEMPTS; attempt++) {
      try {
        await withTimeout(client.publish(turnEventChannel(turnId), message), publishTimeoutMs, `repair publish ${turnId}`)
        return true
      } catch (err) {
        lastError = err
      }
      if (attempt < REPAIR_PUBLISH_ATTEMPTS - 1) await wait(REPAIR_PUBLISH_DELAYS_MS[attempt] ?? 500)
    }
    console.warn(`[worker] streamed-turn ${turnId} — repaired terminal publish FAILED after ${REPAIR_PUBLISH_ATTEMPTS} attempts:`, lastError?.message ?? lastError)
    return false
  } finally {
    if (owned) {
      try { await owned.quit() } catch { owned.disconnect?.() }
    }
  }
}

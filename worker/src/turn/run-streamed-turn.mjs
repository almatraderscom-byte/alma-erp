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

  async function storeDurably(row) {
    let lastError = null
    for (let attempt = 0; attempt < DURABLE_WRITE_ATTEMPTS; attempt++) {
      try {
        const { error } = await supabase.from('agent_turn_events').upsert(row, { onConflict: 'turn_id,seq' })
        if (!error) return true
        lastError = error
      } catch (err) {
        lastError = err
      }
      if (attempt < DURABLE_WRITE_ATTEMPTS - 1) await sleep(DURABLE_RETRY_DELAYS_MS[attempt] ?? 500)
    }
    console.error(`[worker] streamed-turn ${turnId} — durable write seq ${row.seq} FAILED after ${DURABLE_WRITE_ATTEMPTS} attempts:`, lastError?.message ?? lastError)
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
    const stored = await storeDurably(row)
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
          await emit(event)
          if (event?.type === 'done') sawDone = true
          else if (event?.type === 'error') sawError = event.message || 'turn_error'
        }
      }
    }

    // The upstream stream ended without a terminal event: the turn died (hard
    // cap, crash, cancel). Say so — a synthetic `done` without a messageId used
    // to tell the client a canceled/partial turn had succeeded.
    if (!sawDone && !sawError) {
      sawError = 'turn_stream_ended_without_terminal'
      await emit({ type: 'error', message: sawError })
    }

    console.log(`[worker] streamed-turn ${turnId} — ${sawError ? `ended with error "${sawError}"` : 'done'} (${seq} events, ${durableHoles} durable holes, ${Date.now() - startedAt}ms)`)
  } catch (err) {
    sawError = err.message
    console.error(`[worker] streamed-turn ${turnId} failed:`, err.message)
    await emit({ type: 'error', message: err.message })
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

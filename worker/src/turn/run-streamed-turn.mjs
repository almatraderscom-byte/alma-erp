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
 */
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
 */
export async function runStreamedTurn({ supabase, job, redisUrl, telegramBot }) {
  const { turnId, conversationId, message, files, projectId, personalMode, clientRequestId, askCardId } = job.data ?? {}
  if (!turnId || !conversationId || !message) {
    console.warn(`[worker] streamed-turn ${job?.id} — missing turnId/conversationId/message`)
    return
  }

  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: null })
  let seq = 0
  const startedAt = Date.now()
  let sawDone = false
  let sawError = null

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
    // then publish. Upsert keeps it idempotent under BullMQ retries.
    try {
      await supabase.from('agent_turn_events').upsert(row, { onConflict: 'turn_id,seq' })
    } catch (err) {
      console.warn(`[worker] streamed-turn ${turnId} — store seq ${seq} failed:`, err.message)
    }
    try {
      await publisher.publish(turnEventChannel(turnId), JSON.stringify({ seq, type, payload: event }))
    } catch (err) {
      console.warn(`[worker] streamed-turn ${turnId} — publish seq ${seq} failed:`, err.message)
    }
    seq += 1
  }

  try {
    const res = await fetch(`${getAppUrl()}/api/assistant/chat?stream=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getInternalToken()}`,
      },
      body: JSON.stringify({ conversationId, message, files, projectId, personalMode, turnId, clientRequestId, askCardId }),
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

    // If the upstream stream ended without an explicit terminal event, synthesize
    // one so a tailing client isn't left hanging.
    if (!sawDone && !sawError) {
      await emit({ type: 'done', synthetic: true })
      sawDone = true
    }

    console.log(`[worker] streamed-turn ${turnId} — done (${seq} events, ${Date.now() - startedAt}ms)`)
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
      publisher.disconnect()
    }
  }
}

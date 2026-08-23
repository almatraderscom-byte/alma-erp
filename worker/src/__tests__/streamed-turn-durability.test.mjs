/**
 * Reliability epic R-3 — worker durability contract (handoff F-09/F-10/F-11).
 *   node --test worker/src/__tests__/streamed-turn-durability.test.mjs
 *
 * Everything is injected (fake Supabase / Redis publisher / fetch), so the
 * test exercises the real run-streamed-turn.mjs without a network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.APP_URL = 'https://example.test'
process.env.AGENT_INTERNAL_TOKEN = 'test-token'

const { runStreamedTurn, repairMissingTerminal } = await import('../turn/run-streamed-turn.mjs')

/** SSE body from a list of events (plus a keepalive comment, like the route). */
function sseBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(': ping\n\n')
  const bytes = new TextEncoder().encode(text)
  return {
    async *[Symbol.asyncIterator]() {
      // Split mid-frame on purpose: the parser must reassemble chunks.
      const cut = Math.floor(bytes.length / 3)
      yield bytes.slice(0, cut)
      yield bytes.slice(cut)
    },
  }
}

function fakeSupabase({ existingSeqs = [], existingLastType = 'text_delta', existingRows = null, upsertErrorsBySeq = {}, selectError = null, selectErrorsRemaining = null, lastSeqUpdateError = null } = {}) {
  const rows = []
  const lastSeqUpdates = []
  const upsertAttempts = []
  // Rows that were durable before the call under test. `existingSeqs` keeps
  // the older shape (non-terminal rows, the last one typed `existingLastType`).
  const priorRows = existingRows ?? existingSeqs.map((seq, i) => {
    const type = i === existingSeqs.length - 1 ? existingLastType : 'text_delta'
    return { seq, type, payload: type === 'done' ? { type, messageId: 'm' } : { type } }
  })
  const allRows = () => [...priorRows, ...rows]
  const client = {
    rows,
    lastSeqUpdates,
    upsertAttempts,
    from(table) {
      if (table === 'agent_turn_events') {
        return {
          async upsert(row) {
            upsertAttempts.push(row.seq)
            const plan = upsertErrorsBySeq[row.seq]
            if (plan && plan.remaining > 0) {
              plan.remaining -= 1
              return { data: null, error: { message: `injected failure seq ${row.seq}` } }
            }
            if (!rows.some((r) => r.seq === row.seq)) rows.push(row)
            return { data: row, error: null }
          },
          select() {
            // Minimal PostgREST-style builder: eq/in/order/limit, executed at limit().
            const filters = []
            let descending = true
            const builder = {
              eq(col, value) { filters.push((r) => col === 'turn_id' ? true : r[col] === value); return builder },
              in(col, values) { filters.push((r) => values.includes(r[col])); return builder },
              order(_col, { ascending = true } = {}) { descending = !ascending; return builder },
              async limit(n) {
                if (selectErrorsRemaining != null && selectErrorsRemaining > 0) {
                  selectErrorsRemaining -= 1
                  return { data: null, error: { message: 'transient select failure' } }
                }
                if (selectError) return { data: null, error: selectError }
                const matched = allRows().filter((r) => filters.every((f) => f(r)))
                  .sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq))
                return { data: matched.slice(0, n), error: null }
              },
            }
            return builder
          },
        }
      }
      if (table === 'agent_turns') {
        return {
          update(patch) {
            return {
              async eq(_col, id) {
                if (lastSeqUpdateError) return { data: null, error: lastSeqUpdateError }
                lastSeqUpdates.push({ id, last_seq: patch.last_seq })
                return { data: null, error: null }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return client
}

function fakePublisher({ failures = 0 } = {}) {
  const published = []
  let remainingFailures = failures
  return {
    published,
    attempts: 0,
    async publish(_channel, raw) {
      this.attempts += 1
      if (remainingFailures > 0) {
        remainingFailures -= 1
        throw new Error('redis publish down')
      }
      published.push(JSON.parse(raw))
    },
    async quit() {},
  }
}

function fakeFetch(events, { ok = true } = {}) {
  return async () => ({ ok, status: ok ? 200 : 500, body: ok ? sseBody(events) : null, text: async () => 'boom' })
}

const job = { id: 'job-1', data: { turnId: 'turn-1', conversationId: 'conv-1', message: 'হ্যালো', agentProseProtocol: 2 } }
const noSleep = async () => {}

test('happy path: every event is stored, published, and bumps agent_turns.last_seq (F-10)', async () => {
  const supabase = fakeSupabase()
  const publisher = fakePublisher()
  const events = [
    { type: 'conversation_id', id: 'conv-1' },
    { type: 'text_delta', delta: 'বস', blockId: 'turn-1:p1', revision: 1 },
    { type: 'done', messageId: 'msg-1' },
  ]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[0, 'conversation_id'], [1, 'text_delta'], [2, 'done']])
  assert.deepEqual(publisher.published.map((p) => p.seq), [0, 1, 2])
  assert.deepEqual(supabase.lastSeqUpdates, [
    { id: 'turn-1', last_seq: 0 },
    { id: 'turn-1', last_seq: 1 },
    { id: 'turn-1', last_seq: 2 },
  ])
  // The typed prose fields ride through untouched (prose lifecycle v2).
  assert.equal(supabase.rows[1].payload.blockId, 'turn-1:p1')
})

test('a PostgREST { error } is a failure: retried, then stored once; never a silent success (F-10)', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 2 } } })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'tool_start', id: 't', name: 'x' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  assert.deepEqual(supabase.upsertAttempts, [0, 1, 1, 1, 2])
  assert.deepEqual(supabase.rows.map((r) => r.seq), [0, 1, 2])
  assert.deepEqual(publisher.published.map((p) => p.seq), [0, 1, 2])
})

test('an event that can never be stored is not published and does not consume its seq', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 3 } } })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'text_delta', delta: 'lost' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  // seq 1 failed 3 times for the lost delta; the `done` then took seq 1.
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[0, 'conversation_id'], [1, 'done']])
  assert.deepEqual(publisher.published.map((p) => [p.seq, p.type]), [[0, 'conversation_id'], [1, 'done']])
  assert.deepEqual(supabase.lastSeqUpdates.map((u) => u.last_seq), [0, 1])
})

test('a BullMQ retry resumes seq from the durable max instead of overwriting a prior run', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2, 3, 4] })
  const publisher = fakePublisher()
  const events = [{ type: 'text_delta', delta: 'again' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  assert.deepEqual(supabase.rows.map((r) => r.seq), [5, 6])
  assert.deepEqual(publisher.published.map((p) => p.seq), [5, 6])
})

test('an upstream stream that ends without a terminal is reported as an error, never synthetic success (F-11)', async () => {
  const supabase = fakeSupabase()
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'text_delta', delta: 'partial' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  const last = supabase.rows.at(-1)
  assert.equal(last.type, 'error')
  assert.equal(last.payload.message, 'turn_stream_ended_without_terminal')
  assert.ok(!supabase.rows.some((r) => r.type === 'done'), 'no done without a durable assistant message')
})

test('a failed chat call is reported as an error event with the HTTP status', async () => {
  const supabase = fakeSupabase()
  const publisher = fakePublisher()
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch([], { ok: false }), publisher, sleep: noSleep } })

  assert.deepEqual(supabase.rows.map((r) => r.type), ['error'])
  assert.match(supabase.rows[0].payload.message, /chat API 500/)
})

test('an unstored terminal `done` is not accepted: the EOF error is stored instead (Codex P1)', async () => {
  // The `done` at seq 2 fails every attempt of the extended terminal budget (8);
  // the fallback error event takes the same seq and lands on the next try.
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 2: { remaining: 8 } } })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'text_delta', delta: 'x' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })

  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[0, 'conversation_id'], [1, 'text_delta'], [2, 'error']])
  assert.equal(supabase.rows[2].payload.message, 'turn_terminal_not_durable:done')
  assert.ok(!publisher.published.some((p) => p.type === 'done'), 'no synthetic success reached the live tail')
})

test('when no terminal can be stored at all the job rejects so BullMQ retries (Codex P1)', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 2: { remaining: 99 } } })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'text_delta', delta: 'x' }, { type: 'done', messageId: 'm' }]
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep, enqueueRepair: async () => {} } }),
    /terminal event could not be stored durably/,
  )
  assert.deepEqual(supabase.rows.map((r) => r.seq), [0, 1])
})

test('a terminal write gets the extended in-process retry budget (Codex P1 #837)', async () => {
  // The `done` at seq 1 fails 5 times, then lands — well past the ordinary 3 attempts.
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 5 } } })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[0, 'conversation_id'], [1, 'done']])
  assert.equal(supabase.upsertAttempts.filter((s) => s === 1).length, 6)
})

test('a stale delivery for a finished turn repairs a missing terminal without re-running the turn', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2] })
  // The last durable row was a text delta: the log has no terminal.
  const repaired = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done' })
  assert.deepEqual(repaired, { outcome: 'repaired', seq: 3 })
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type, r.payload.message]), [[3, 'error', 'turn_terminal_repaired:done']])
  assert.deepEqual(supabase.lastSeqUpdates, [{ id: 'turn-1', last_seq: 3 }])
})

test('a lost terminal is handed to the repair-only job with the REAL terminal event (Codex P1 #837 r3)', async () => {
  // The turn job runs with attempts:1 — without its own job the repair path
  // would never run. The carried `done` keeps the messageId for the client.
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 99 }, 2: { remaining: 99 } } })
  const publisher = fakePublisher()
  const enqueued = []
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm-real' }]
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep, enqueueRepair: async (data) => { enqueued.push(data) } } }),
    /terminal event could not be stored durably/,
  )
  assert.deepEqual(enqueued, [{ turnId: 'turn-1', status: 'done', terminal: { type: 'done', messageId: 'm-real' } }])
})

test('a failing repair enqueue is retried, never masks the original failure, and is scheduled once per job', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 99 }, 2: { remaining: 99 } } })
  const publisher = fakePublisher()
  let calls = 0
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm' }]
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep, enqueueRepair: async () => { calls += 1; throw new Error('redis down') } } }),
    /terminal event could not be stored durably/,
  )
  assert.equal(calls, 3, 'three enqueue attempts (Codex P1 #837 r5), then the original throw')
})

test('a transient enqueue failure succeeds on retry', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 99 }, 2: { remaining: 99 } } })
  const publisher = fakePublisher()
  const enqueued = []
  let calls = 0
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm' }]
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep, enqueueRepair: async (data) => { calls += 1; if (calls === 1) throw new Error('blip'); enqueued.push(data) } } }),
    /terminal event could not be stored durably/,
  )
  assert.equal(calls, 2)
  assert.equal(enqueued.length, 1)
})

test('a publish that never returns is bounded by the publish timeout (Codex P1 #837 r5)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2] })
  const hanging = { attempts: 0, published: [], async publish() { this.attempts += 1; await new Promise(() => {}) }, async quit() {} }
  const result = await repairMissingTerminal({
    supabase, turnId: 'turn-1', status: 'done', terminal: { type: 'done', messageId: 'm' }, publisher: hanging, sleep: noSleep, publishTimeoutMs: 20,
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /not published/)
  assert.equal(hanging.attempts, 3, 'each bounded attempt timed out, the loop advanced')
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[3, 'done']])
})

test('the repair stores the carried terminal verbatim and publishes it to live subscribers (Codex P1 #837 r3)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2] })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({
    supabase, turnId: 'turn-1', status: 'done', terminal: { type: 'done', messageId: 'm-real' }, publisher,
  })
  assert.deepEqual(result, { outcome: 'repaired', seq: 3 })
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type, r.payload]), [[3, 'done', { type: 'done', messageId: 'm-real' }]])
  assert.deepEqual(publisher.published, [{ seq: 3, type: 'done', payload: { type: 'done', messageId: 'm-real' } }])
  assert.deepEqual(supabase.lastSeqUpdates, [{ id: 'turn-1', last_seq: 3 }])
})

test('a log that already holds a terminal is left alone, and the terminal is republished for subscribed tails', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], existingLastType: 'done' })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher })
  assert.deepEqual(result, { outcome: 'already_terminal', seq: 2 })
  assert.deepEqual(supabase.rows, [])
  assert.deepEqual(publisher.published, [{ seq: 2, type: 'done', payload: { type: 'done', messageId: 'm' } }])
})

test('a terminal that is not the LAST row (done, then conversation_compacted) is still a terminal (Codex P1 #837 r4)', async () => {
  const supabase = fakeSupabase({ existingRows: [
    { seq: 0, type: 'text_delta', payload: { type: 'text_delta', delta: 'x' } },
    { seq: 1, type: 'done', payload: { type: 'done', messageId: 'm' } },
    { seq: 2, type: 'conversation_compacted', payload: { type: 'conversation_compacted' } },
  ] })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher })
  assert.deepEqual(result, { outcome: 'already_terminal', seq: 1 })
  assert.deepEqual(supabase.rows, [], 'no bogus turn_terminal_repaired row behind a valid done')
  assert.deepEqual(publisher.published.map((p) => [p.seq, p.type]), [[1, 'done']])
})

test('a repair whose publish fails is reported as failure so the job retries; the retry republishes (Codex P1 #837 r4)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2] })
  const down = fakePublisher({ failures: 99 })
  const first = await repairMissingTerminal({
    supabase, turnId: 'turn-1', status: 'done', terminal: { type: 'done', messageId: 'm-real' }, publisher: down, sleep: noSleep,
  })
  assert.equal(first.outcome, 'failed')
  assert.match(first.error, /not published/)
  assert.equal(down.attempts, 3, 'bounded publish retries')
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type]), [[3, 'done']], 'the row itself is durable')

  const up = fakePublisher()
  const retry = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher: up, sleep: noSleep })
  assert.deepEqual(retry, { outcome: 'already_terminal', seq: 3 })
  assert.deepEqual(up.published, [{ seq: 3, type: 'done', payload: { type: 'done', messageId: 'm-real' } }])
  assert.deepEqual(supabase.rows.map((r) => r.seq), [3], 'no second terminal row')
})

test('a transient publish failure is retried in process', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2] })
  const flaky = fakePublisher({ failures: 1 })
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher: flaky, sleep: noSleep })
  assert.deepEqual(result, { outcome: 'repaired', seq: 3 })
  assert.equal(flaky.attempts, 2)
  assert.equal(flaky.published.length, 1)
})

test('a repair that cannot write reports failure — never a silent success (Codex P1 #837 r3)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], upsertErrorsBySeq: { 3: { remaining: 99 } } })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /injected failure seq 3/)
  assert.deepEqual(publisher.published, [])
})

test('a durable seq lookup that keeps failing fails the delivery — never starts at 0 blind (Codex P1 #837 r6)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], selectError: { message: 'postgrest down' } })
  const publisher = fakePublisher()
  let fetched = 0
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: async () => { fetched += 1; throw new Error('must not be called') }, publisher, sleep: noSleep } }),
    /durable seq lookup failed/,
  )
  assert.equal(fetched, 0, 'the chat route is never called')
  assert.deepEqual(supabase.rows, [], 'no row was written at seq 0')
})

test('a transient seq lookup failure is retried and the sequence resumes after the durable max', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2, 3, 4], selectErrorsRemaining: 2 })
  const publisher = fakePublisher()
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm' }]
  await runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } })
  assert.deepEqual(publisher.published.map((p) => p.seq), [5, 6])
})

test('a repair whose last_seq update fails is reported as failure (Codex P1 #837 r6)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], lastSeqUpdateError: { message: 'postgrest down' } })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', terminal: { type: 'done', messageId: 'm' }, publisher, sleep: noSleep })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /last_seq update failed/)
  assert.deepEqual(publisher.published, [], 'not declared complete')
})

test('an existing terminal also re-stamps last_seq to the true max before republishing', async () => {
  const supabase = fakeSupabase({ existingRows: [
    { seq: 0, type: 'text_delta', payload: { type: 'text_delta', delta: 'x' } },
    { seq: 1, type: 'done', payload: { type: 'done', messageId: 'm' } },
    { seq: 2, type: 'conversation_compacted', payload: { type: 'conversation_compacted' } },
  ] })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher, sleep: noSleep })
  assert.deepEqual(result, { outcome: 'already_terminal', seq: 1 })
  assert.deepEqual(supabase.lastSeqUpdates, [{ id: 'turn-1', last_seq: 2 }])
})

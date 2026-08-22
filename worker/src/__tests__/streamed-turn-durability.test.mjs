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

function fakeSupabase({ existingSeqs = [], existingLastType = 'text_delta', upsertErrorsBySeq = {}, selectError = null } = {}) {
  const rows = []
  const lastSeqUpdates = []
  const upsertAttempts = []
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
            return {
              eq() {
                return {
                  order() {
                    return {
                      async limit() {
                        if (selectError) return { data: null, error: selectError }
                        const max = existingSeqs.length ? Math.max(...existingSeqs) : null
                        return { data: max == null ? [] : [{ seq: max, type: existingLastType }], error: null }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'agent_turns') {
        return {
          update(patch) {
            return {
              async eq(_col, id) {
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

function fakePublisher() {
  const published = []
  return {
    published,
    async publish(_channel, raw) { published.push(JSON.parse(raw)) },
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

test('a failing repair enqueue never masks the original failure and is scheduled only once', async () => {
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 1: { remaining: 99 }, 2: { remaining: 99 } } })
  const publisher = fakePublisher()
  let calls = 0
  const events = [{ type: 'conversation_id', id: 'c' }, { type: 'done', messageId: 'm' }]
  await assert.rejects(
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep, enqueueRepair: async () => { calls += 1; throw new Error('redis down') } } }),
    /terminal event could not be stored durably/,
  )
  assert.equal(calls, 1)
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

test('a log that already ends with a terminal is left alone (idempotent repair)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], existingLastType: 'done' })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher })
  assert.deepEqual(result, { outcome: 'already_terminal', seq: 2 })
  assert.deepEqual(supabase.rows, [])
  assert.deepEqual(publisher.published, [])
})

test('a repair that cannot write reports failure — never a silent success (Codex P1 #837 r3)', async () => {
  const supabase = fakeSupabase({ existingSeqs: [0, 1, 2], upsertErrorsBySeq: { 3: { remaining: 99 } } })
  const publisher = fakePublisher()
  const result = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done', publisher })
  assert.equal(result.outcome, 'failed')
  assert.match(result.error, /injected failure seq 3/)
  assert.deepEqual(publisher.published, [])
})

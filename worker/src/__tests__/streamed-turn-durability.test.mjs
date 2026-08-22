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

function fakeSupabase({ existingSeqs = [], upsertErrorsBySeq = {}, selectError = null } = {}) {
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
                        return { data: max == null ? [] : [{ seq: max }], error: null }
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
  // The `done` at seq 2 fails every attempt; the fallback error event takes the same seq and lands.
  const supabase = fakeSupabase({ upsertErrorsBySeq: { 2: { remaining: 3 } } })
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
    runStreamedTurn({ supabase, job, redisUrl: 'redis://unused', telegramBot: null, deps: { fetch: fakeFetch(events), publisher, sleep: noSleep } }),
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
  // The fake select returns only the max seq; pretend the last row was a text delta.
  const repaired = await repairMissingTerminal({ supabase, turnId: 'turn-1', status: 'done' })
  assert.equal(repaired, true)
  assert.deepEqual(supabase.rows.map((r) => [r.seq, r.type, r.payload.message]), [[3, 'error', 'turn_terminal_repaired:done']])
  assert.deepEqual(supabase.lastSeqUpdates, [{ id: 'turn-1', last_seq: 3 }])
})
